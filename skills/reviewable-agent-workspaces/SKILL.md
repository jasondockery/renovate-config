---
name: reviewable-agent-workspaces
description: Keep agent implementation in an explicit, visible, human-reviewable workspace with one writer, stable identity, complete diff visibility, and lossless cleanup. Use before editing code or documents, delegating parallel implementation, choosing a branch or worktree, running proof in a detached or temporary checkout, reporting progress, committing remote work, relocating a task, or cleaning up an agent workspace.
---

# Reviewable agent workspaces

Implementation must stay visible to the human review surface declared for the
task. A convenient hidden checkout is not an implementation workspace.

Load `shift-to-authority` for substantial reviews, cross-repository work, and
handoffs. Load `verification-selection` when choosing proof. Apply both without
copying their contracts here.

## Declare the workspace

Before editing, report:

- repository and exact base SHA;
- branch and current commit;
- absolute implementation root;
- human review surface; and
- visible checkout cleanliness and any other writer occupying it.

For local interactive work, use the workspace attached to the user's task or
editor. Do not silently relocate implementation when another writable checkout
would be easier. If that workspace is dirty or occupied by unrelated work,
report the exact paths and stop; never stash, reset, overwrite, relocate, or
hide those bytes without authority.

## Preserve reviewability

1. Assign one writable agent to each worktree. Parallel writers use one named
   branch and worktree each only when that workspace is explicitly registered
   or opened as reviewable, or when a visible branch or draft pull request is
   the declared review surface.
2. Keep the implementation root stable. Any authorized move requires a new
   declaration before writing at the new root.
3. Report progress with repository path, branch, base SHA, current commit, and
   review location. A status message must not conceal where uncommitted bytes
   live.
4. Make the complete pre-commit diff visible in the declared review surface.
   Staged state alone is not a complete review surface.
5. A remote agent may commit before local review only when its visible branch or
   pull request was declared as the review surface. Otherwise it exposes the
   complete working diff before committing.

## Separate proof workspaces

`/tmp`, `/private/tmp`, caches, and detached worktrees are proof-only. Use them
for exact-SHA validation, packing, reconstruction, consumer fixtures,
corruption tests, and idempotence tests—not for authoring source changes.

A proof worktree is clean, identity-bound, source-read-only for the proof, and
disposable. Proof output may be written outside its source tree. Never promote
unreviewed proof-worktree edits into implementation.

## Clean up safely

Before removing a branch or worktree, prove that every intended commit is
reachable from the declared retained review surface and that no staged,
unstaged, or untracked implementation byte will be lost. If reachability,
ownership, or cleanliness is uncertain, preserve the workspace and report it.

## Report

Report the declared repository, base, branch, implementation root, review
surface, current commit, cleanliness, writer ownership, complete-diff location,
proof-only roots, and cleanup disposition. Keep tool-specific workspace,
editor, branch-publication, and review mechanics in their owning repository.
