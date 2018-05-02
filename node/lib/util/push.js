/*
 * Copyright (c) 2016, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";

/**
 * This module contains methods for pushing.
 */

const assert  = require("chai").assert;
const co      = require("co");
const colors  = require("colors");
const NodeGit = require("nodegit");

const DoWorkQueue         = require("./do_work_queue");
const GitUtil             = require("./git_util");
const SubmoduleUtil       = require("./submodule_util");
const SubmoduleConfigUtil = require("./submodule_config_util");
const SyntheticBranchUtil = require("./synthetic_branch_util");
const UserError           = require("./user_error");

/**
 * For each open submodule that exists in the commit indicated by the specified
 * `source`, push a synthetic-meta-ref for the `source` commit.
 * If all sub-repo pushes succeed, push `source` to
 * to the specified `target` branch in `remoteName`.  If any pushes fail, throw
 * a `UserError` object.
 *
 * Note that this strategy is naive: it does not handle the following
 * situations:
 *
 * - closed submodules with commits that need to be pushed
 * - submodules that do not exist in the `source` commit, but did previously
 *   and need synthetic-meta-refs
 * - submodules with divergent histories, i.e., the commit we create the
 *   synthetic-meta-ref for doesn't contain one or more commits that need to be
 *   pushed in its history
 *
 * Addressing these situations would have a performance impact, requiring
 * calculation and traversal of all meta-repo commits being pushed.  We should
 * probably add a way to do an "exhaustive" push.
 *
 * @async
 * @param {NodeGit.Repository} repo
 * @param {String}             remoteName
 * @param {String}             source
 * @param {String}             target
 * @param {Boolean}            force
 */
exports.push = co.wrap(function *(repo, remoteName, source, target, force) {
    assert.instanceOf(repo, NodeGit.Repository);
    assert.isString(remoteName);
    assert.isString(source);
    assert.isString(target);
    assert.isBoolean(force);

    let remoteUrl = yield GitUtil.getUrlFromRemoteName(repo, remoteName);

    // First, push the submodules.
    const annotatedCommit = yield GitUtil.resolveCommitish(repo, source);
    const sha = annotatedCommit.id();
    const commit = yield repo.getCommit(sha);

    const submoduleSet = new Set(yield SubmoduleUtil.listOpenSubmodules(repo));
    for (const s of yield SubmoduleUtil.listAbsorbedSubmodules(repo)) {
        submoduleSet.add(s);
    }
    const submodules = [...submoduleSet];
    const pushMap = yield SubmoduleUtil.getSubmoduleShasForCommit(repo,
                                                                  submodules,
                                                                  commit);
    const trackingBranches = new Set();
    trackingBranches.add(`refs/remotes/${remoteName}/${target}`);
    let tracking;
    try {
        const sourceBranch = yield repo.getReference(source);
        tracking = yield GitUtil.getTrackingInfo(repo, sourceBranch);
    } catch (e) {
        // we have no local branch? maybe source is a sha.
        tracking = null;
    }

    if (tracking !== null) {
        if (tracking.remoteName !== null) {
            trackingBranches.add(
                `refs/remotes/${remoteName}/${tracking.remoteName}`);
        }
        if (tracking.pushRemoteName !== null) {
            trackingBranches.add(
                `refs/remotes/${remoteName}/${tracking.pushRemoteName}`);
        }
    }

    for (const branch of trackingBranches) {
        const annotated = yield GitUtil.resolveCommitish(repo, branch);

        if (annotated !== null) {
            const trackingCommit = yield NodeGit.Commit.lookup(repo,
                                                               annotated.id());
            const tree = yield trackingCommit.getTree();
            for (const sub of Object.keys(pushMap)) {
                let entry;
                try {
                    entry = yield tree.entryByPath(sub);
                } catch (e) {
                    //not found, OK
                    continue;
                }
                // easy check: does the tracking branch's id equal the one
                // in the pushMap?  If not, it would be possible that the
                // tracking branch were *ahead*, but this is so unlikely as
                // to be not worth opening up the repo to check
                if (entry.id() === pushMap[sub]) {
                    delete pushMap[sub];
                }
            }
        }
    }

    let errorMessage = "";

    const urls = yield SubmoduleConfigUtil.getSubmodulesFromCommit(repo,
                                                                   commit);

    const pushSub = co.wrap(function *(subName) {
        // Push to a synthetic branch; first, calculate name.

        const sha = pushMap[subName];
        const syntheticName =
                          SyntheticBranchUtil.getSyntheticBranchForCommit(sha);
        const subRepo = yield SubmoduleUtil.getRepo(repo, subName);

        // Resolve the submodule's URL against the URL of the meta-repo,
        // ignoring the remote that is configured in the open submodule.

        const subUrl = SubmoduleConfigUtil.resolveSubmoduleUrl(remoteUrl,
                                                               urls[subName]);

        // Always force push synthetic refs.  It should not be necessary, but
        // if something does go wrong forcing will allow us to auto-correct.
        // If they succeed, no need to print the output inside the submodules.

        const pushResult = yield GitUtil.push(subRepo,
                                              subUrl,
                                              sha,
                                              syntheticName,
                                              true,
                                              true);
        if (null !== pushResult) {
            errorMessage +=
           `Failed to push submodule ${colors.yellow(subName)}: ${pushResult}`;
        }
    });
    yield DoWorkQueue.doInParallel(Object.keys(pushMap), pushSub);

    // Throw an error if there were any problems pushing submodules; don't push
    // the meta-repo.

    if ("" !== errorMessage) {
        throw new UserError(errorMessage);
    }

    // Finally, push the meta-repo and throw on failure.

    const result = yield GitUtil.push(repo, remoteName, source, target, force);
    if (null !== result) {
        throw new UserError(`Failed to push meta-repo: ${result}`);
    }
});
