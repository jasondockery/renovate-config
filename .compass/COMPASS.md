# Compass

## Simple first

Prefer one excellent normal path, strong defaults, progressive capability, and
small composable parts. Do not add settings, workflows, abstractions, providers,
modes, screens, dependencies, compatibility paths, or services for hypothetical
users. Complexity must be earned by a demonstrated requirement.

Evidence earns complexity; measurement keeps it.

## Foundational identity and reference authority

Foundational identity and reference concepts have one canonical authority.
Preserve these separations:

- Person or organization identity is not an authentication principal.
- A business role is not an authorization grant.
- A canonical entity is not an external or source-system identifier.
- A reference system is not a context-specific selection.
- Foundational authority is not an application-specific convenience model.
- Identity remains separate from mutable names, labels, paths, locations,
  revisions, provider identifiers, credentials, and presentation.

A reference is a context-bound locator that resolves to identity, not a
substitute for identity. Applications must not establish competing generic
people, organization, user, role, or lookup-list foundations after the
corresponding shared capability is selected.

Keep the shared authority technology-neutral. Concrete schemas, persistence,
commands, provider mechanics, and application fields remain with the product
that owns them.

## Optional capability and provider boundaries

Selection is an architectural boundary, not merely a feature flag. An
unselected capability contributes zero implementation dependencies, binaries,
runtime configuration, environment variables, credentials, secrets, workflows,
infrastructure, network requests, persistent data, generated application
authority, installation work, build work, runtime work, or consumer toolchain
requirements.

Capability absence must be observable through construction, distribution,
verification, operation, removal, and recovery. A default, transitive,
generated, dormant, or conditionally unused capability contribution is still a
footprint.

Provider conformance has two independent requirements.

First, an unselected provider contributes zero consumer-owned authority or
behavior: no adapter, configuration, credentials or secrets, workflows,
infrastructure, deployment commands or destinations, network behavior,
persistent state, or consumer-owned imports. A package namespace alone neither
selects a provider nor authorizes its behavior.

Second, a selected provider's governed dependency closure may include
explicitly declared transitive implementation packages even when a package
namespace names another provider. Every such byte remains supply-chain
footprint; it is not zero footprint and does not confer authority for the named
provider.

Bind the complete selected-provider closure to an exact transitive SBOM,
version, digest, license, advisory status, and validation receipt. Prove no
consumer-owned authority or behavior for an unselected provider, no network
requests to it, and no client or SDK code for it in the deployed artifact.
Removing the selected provider removes its complete transitive closure.
Permitted closure changes fail closed until the new closure and deployed bytes
pass the same evidence.

A temporary exception cannot convert either failed provider requirement into
conformance. Changing these semantics requires a new Compass identity and new
consumer projections.

## Proven provider neutrality

A supposedly generic provider seam is provisional until at least two real
implementations prove the common lifecycle.

First-provider mechanics remain provider-owned. Promote only lifecycle
semantics demonstrated by both implementations into shared core, including
selection, operation, failure, replacement, removal, unselected-provider
authority and behavior, and governed dependency closure. Similar names or a
hypothetical second provider are not evidence of neutrality.

## Replaceable AI workload implementations

AI models and inference backends are replaceable implementations of named
product workloads. Product code targets an explicit workload and capability
contract, not vendor or model SDK identity and not a universal
lowest-common-denominator client. Required text, streaming, structured-output,
tool, embedding, modality, context, cancellation, timeout, offline, and health
behavior is explicit; an unsupported requirement fails planning or startup
instead of silently degrading.

Selections name the backend and exact model for a workload, environment, and
hardware class where needed. Mutable aliases are not accepted identity.
Fallback defaults to none. Moving from local to hosted inference or between
processors requires explicit product policy, applicable privacy review,
observable effective selection, and fail-closed boundaries. A refresh,
temporary outage, or unavailable capability never authorizes silent data
transfer or a weaker model path.

An unselected adapter, backend, or model contributes zero dependency,
configuration, credential, workflow, download, runtime, persistent, or network
footprint. Bind downloadable selections to the exact model revision, artifact
or weights digest, quantization, license, model card and provenance, runtime and
adapter identity, platform and architecture, and evaluation receipt. Bind
hosted selections to the strongest immutable provider, model, deployment, and
API identity available and disclose remaining mutability.

Never download large weights automatically. Explicit selection discloses disk,
RAM, VRAM, and network estimates plus complete removal behavior. Discovery may
nominate but never promote. The selection lifecycle is `discovered → candidate
→ accepted → default → retired`, separate from the Shift to Authority
lifecycle. Acceptance and default promotion occur per workload after
owner-reviewed representative platform and workload evidence. Different
workloads may legitimately retain different models and backends.

Evaluation covers task success and quality, tool reliability, structured
output, streaming, cancellation and errors, latency p50 and p95, memory, CPU,
GPU, cost, privacy, transfer and retention, license, advisories, provenance,
offline behavior, rollback, and complete removal. User-facing settings and
diagnostics reveal the exact workload, model, backend, locality or data
boundary, status, and fallback policy through one repository-owned registry and
message authority. Credentials, personal and product data, prompts, outputs,
tool arguments, logs, retention, processors, and telemetry remain governed by
privacy and security doctrine. Provider or protocol compatibility is not
capability conformance.

`ai-workload-policy.json` is the normative structured source for this contract;
`skills/ai-backend-change/SKILL.md` supplies the procedure. Products retain
their schemas, adapters, commands, templates, provisioning, hardware support,
workload choices, consent, and deployed acceptance.

## Operable developer tools

A developer tool is adopted only when its intended workflows, material
defaults, supported-platform configuration, discoverability, safe interaction
and recovery controls, effective installed behavior, and limitations are
intentionally reconciled and proven. Executable presence alone is insufficient.
Use an explicit per-tool mapping from intended behaviors to recovery, platform
applicability, configuration ownership, and effective evidence IDs; broad
inventory groups cannot establish adoption.

Review upstream defaults for the exact pinned version. Record the review date,
source evidence, every material default's deliberate disposition, and the
upgrade trigger that invalidates the review. Never presume that an upstream
default fits the intended workflow. User-owned configuration is merged or
migrated, or its conflict is reported; it is never silently overwritten. Safe
target inspection covers every parent path component, not only the final file.

Discovery remains purpose-aware. Browsers and file managers expose
developer-relevant project state, interactive pickers can find relevant
dotfiles, and search has an obvious hidden-aware mode while ordinarily
respecting ignore rules. Hidden-aware discovery excludes version-control
internals, caches, ignored outputs, and binary data unless the user explicitly
requests them. Broader discovery never silently broadens a destructive
operation.

Effective proof executes the installed user-facing surface on every claimed
supported platform. Template text, package inventory, and an equivalent raw
command do not prove the configured interaction. Acceptance isolates home and
configuration state and cleans it on success, failure, and signals. Rollback
and removal are race-safe, affect only authority-owned configuration, and
preserve user-owned files and parent paths.

`skills/developer-tool-change/SKILL.md` supplies the procedure. Groundwork owns
concrete developer-environment packages, configuration, and platform
acceptance; Roost owns generated-repository tools, templates, and parity; each
product owns specialized workflow acceptance. Compass does not choose a tool,
package manager, shell, configuration grammar, template system, container
runner, or filesystem transaction design.

## Native hot paths with stable interfaces

Prefer native implementations for measured developer-tooling hot paths while
retaining stable ecosystem-facing interfaces.

Agents make rewrites cheaper. They do not make equivalence cheaper.

Choose an external contract before choosing an implementation. A native
experiment earns adoption only through measured improvement, complete
differential equivalence, provenance-bound distribution, a tested rollback
path, and an explicit accept or reject decision. Consumers own the language,
toolchain, packaging, budgets, and rollout. An unselected source-build
capability must not impose a compiler or language toolchain on consumers. The
projected Compass checker remains dependency-free JavaScript; it is not a
native-rewrite candidate.

## Fast by design

Performance is product behavior. Account for user latency, developer waiting
time, local startup, build and test time, CI and deployment duration, CPU,
memory, storage, network transfer, cloud resources, and dependency weight.
Correct obviously avoidable costs when they are introduced instead of deferring
them to a generic optimization phase.

## Stable interaction by default

An interactive element retains its position and dimensions across loading,
hover, focus, current, pending, success, error, and value states unless the
user explicitly requested that specific reflow, expansion, collapse, reorder,
or relocation and the resulting change cannot retarget an active pointer or
displace logical focus. A refresh request does not authorize result movement.
Pointer-down and pointer-up must not resolve to different actions because
content moved. Do not insert, remove, or reorder enabled targets under an active
pointer or keyboard focus.

State communication must preserve stable control identity, geometry, and
logical focus. A status change must not replace an action label; a label changes
only when the action itself changes. Asynchronous refresh, localization, error,
empty, and status presentation must reserve or reuse stable regions instead of
making the user's current target move. Keep field, lab, automated, and manual
evidence claims distinct; a broad field budget does not excuse an unexpected
shift in an exact interaction flow.

When identity, personal preferences, accessibility settings, or account actions
are available, related applications present each applicable surface in a
consistent and predictable location. Adding or removing a capability must not
unexpectedly relocate an existing surface or change its stable interaction
geometry. Compass owns generic behavior and proof; products own routes,
packages, components, persistence, and authentication mechanics.

## Efficient by default

Spend resources in proportion to user value. Avoid duplicated computation,
unnecessary data movement and CI work, redundant builds, oversized artifacts,
gratuitous dependencies, and unnecessary services.

Run work at the cheapest correct boundary. A remote data owner, database, or
search service filters, sorts, projects, aggregates, and pages remote or
potentially unbounded collections. A server or API authorizes, validates, and
exposes a bounded contract. A browser renders that bounded result. Bounded
already-local collections may be manipulated locally when that is simpler.

## Bound the work

Give finite work a defensible bound where applicable: time, retries,
concurrency, processes, memory, disk, pagination, records scanned, network
requests, and artifact or log size. A retry count without a cumulative deadline
is still unbounded. Unbounded work requires explicit justification.

Distinguish a hard deadline, a quiet or stall threshold, a performance budget,
and an outer workflow timeout; they require different responses. Cancellation
owns the complete child or request tree, preserves original failure evidence,
and reports a recovery action.

## Evidence earns architecture

Measure the constraint before introducing a cache, queue, distributed service,
extra infrastructure, abstraction, configuration surface, or provider. Keep
the added mechanism only while evidence shows it earns its operational and
cognitive cost.

## Verification is part of efficiency

Test behavior at its natural execution boundary and use the cheapest reliable
proof that establishes the failure mode. More tests are not automatically
better; each test must justify both the confidence gained and its resource and
time cost.

Preferred boundaries for the current TypeScript and JavaScript ecosystem are:

| Behavior | Preferred proof |
| --- | --- |
| Pure logic or domain behavior | Vitest or an equivalent unit runner |
| Browser-dependent component behavior | Vitest Browser Mode or equivalent real-browser component proof |
| Composed application or user journeys | Playwright or equivalent end-to-end browser proof |
| Shell, CLI, or process behavior | Executable script tests with hostile fixtures |
| YAML, workflows, or configuration | Parser, schema, and semantic or policy checks |
| JSON contracts and configuration | Schema plus semantic contract tests |
| Generated files and templates | Generation plus parity or drift checks |
| Database semantics | Integration at the real relevant database boundary |
| API contracts | Focused contract or integration tests |
| Distributed packages and artifacts | Clean packed external-consumer proof |
| CI/CD | Static validation, repository-command proof, and hosted exact-SHA execution when hosted execution is the acceptance boundary |
| Deployment | Bounded smoke or browser acceptance against the exact deployed SHA |

Equivalent tools are valid when another stack requires them. Do not force every
technology into every repository. A test that exists but is not discovered by
canonical verification is not coverage.

CI and local proof should fail fast, run independent work concurrently, avoid
duplicate proof, reuse trustworthy deterministic computation, use dependency or
affected awareness, cancel obsolete work, and cache only while correctness
remains explicit. Measure suite, job, build, and deploy duration. Do not solve
an economics failure by merely raising a budget. CI minutes and developer
waiting time are finite engineering resources.

Quality moves left until the cheapest reliable boundary owns it. What cannot be
automated remains an explicit human acceptance boundary, not an omitted
requirement or an automated claim that exceeds its evidence.

## Secure by default

Minimize attack surface and privilege. Protect secrets and sensitive data,
validate trust boundaries, prefer verified dependencies and immutable
provenance, and fail closed when a required security control cannot be
established. Keep security mechanisms proportional to the demonstrated threat;
security does not justify speculative architecture.

## Fail explicitly and recover cleanly

Do not silently bypass a policy because it cannot be enforced. Do not mask a
meaningful child, signal, pipeline, or failure status. Cleanup and recovery are
bounded, idempotent where applicable, and preserve the first authoritative
failure.

A field failure is evidence that the earlier proof boundary was incomplete.
Reproduce it cleanly, explain the divergence, repair the cause, shift prevention
to the cheapest reliable earlier boundary, propagate the pattern to generated
consumers, and retain red and green evidence.

## Reproducibility and provenance

Distinguish working-tree proof, exact-commit proof, hosted exact-SHA proof, and
deployed acceptance. No lower level implies a higher one. Distributed and
generated artifacts bind to immutable source identities, include checksums and
provenance, and are proven through the bytes consumers actually receive.

## Owner-controlled working state

The working tree, index, untracked paths, branches, stashes, and history are
owner-controlled state. Whether a change is staged or unstaged does not
establish ownership, task scope, approval, or permission to commit it. A human
may stage or unstage changes for review without transferring authority over
them.

Preserve pre-existing owner state. Do not normalize, stage, unstage, reset,
stash, clean, amend, rebase, or force-push unrelated state. Determine task
ownership from the task's authority and the observed baseline, not from the
index.

When Git mutation is authorized, inspect the complete task diff independently
of staging, stage only task-attributable changes, and avoid broad staging such
as `git add -A` when unrelated state exists. Do not sweep unrelated staged
content into a task commit. If owner and agent changes in the same file cannot
be separated safely, stop for owner direction.

Branch, ruleset, review, required-check, and bypass decisions are owner
authority and are never inferred from technical access. Each repository owns
its autonomy model, including whether an authorized agent may commit and push
or must stop at a review boundary.

## Shift to Authority

Move a recurring standard, contract, implementation, or proof requirement from
consumers to the canonical owner best positioned to maintain it. The concern
must be reusable and stable within that authority's declared scope. Compass
candidates remain product-, framework-, provider-, and deployment-independent;
other authorities may intentionally own those mechanics.

A local repair proceeds immediately but must not establish a competing shared
authority. Consumer movement remains prohibited until an immutable authority
identity and formal handoff are issued. Adoption includes consumer-owned proof
and reconciliation of provisional duplicated policy.

`authority-policy.json` is the normative structured definition of the Shift to
Authority lifecycle, states, relationships, ownership scopes, required review
classes, and new-authority prerequisites. `authority-registry.json` separately
owns current candidate state, evidence, ordered transitions, issuance bindings,
and historical adoption holds. The projected JSON Schemas define portable
record structure; the dependency-free projected validator is the normative
semantic authority for lifecycle transitions, cross-record identity, provider
provenance, and adoption.
`skills/shift-to-authority/SKILL.md` loads and executes those contracts rather
than duplicating them. Other documents summarize or link to those authorities.

Authority issuance and consumer adoption are separate facts. An issued Compass
candidate names the concrete projected path, schema, and repository of its
containing receipt; the canonical validator resolves that receipt to exact
seven-dimensional values. Every direct consumer owns its reconciliation record,
exact authority identity, local status, hosted-proof contract, and transition
history. The projected validator accepts one projection root, one declared
consumer root, and one repository-relative reconciliation path in one
invocation. It derives policy, registry, schemas, and receipt from the projection
root, performs complete projection-integrity verification, rejects symlinked
governed roots or ancestors, and cross-binds candidate existence, issued state,
receipt identity, and relationship without consumer-specific authority logic. A
downstream relationship additionally requires the intermediary authority's
complete registry and receipt bundle. Its registry authority, policy entry,
issued receipt binding, and receipt source must match the canonical repository
recorded by Compass policy; a caller-created self-signed bundle is invalid. A
truly inapplicable relationship records why.

A source-code defect creates a source-wide `historical-not-adoptable` hold keyed
by repository, source commit, source tree, and source fingerprint. Every receipt
for that exact source is rejected, including a fresh receipt the registry has
never observed. The hold repository must equal the canonical repository of its
authority in the normative policy; valid syntax from another repository cannot
disable the hold. Known seven-dimensional identities remain immutable observed
evidence beneath the source hold; the required observation array may be empty
when no receipt exists yet, while every known distinct receipt is retained and
exact duplicate observations are rejected. An artifact- or receipt-local defect
may
instead create an exact seven-dimensional hold with explicit
`artifact-receipt` scope, which does not hold other receipts for the same source.
The canonical validator enforces both scopes against containing projections and
consumer authority identities. A mechanically green successor that omits or
mis-scopes a required supersession hold is diagnostic rather than issuable.

Until the consumer reaches `adopted` with complete successful hosted proof, call
the record a **consumer reconciliation record**, not adoption evidence. Adoption
evidence begins from a provider-proven prior record at `pending-adoption`. That
prior record must use the same canonical path, consumer identity, hosted-proof
contract snapshot, candidate, relationship, authority identity, completed local
reconciliation, and transition history; the current candidate may add only the
final adopted transition and hosted evidence. The consumer-level contract is a
default for new pending work; each pending or adopted candidate retains its
immutable historical snapshot. Evidence further binds the
provider-reported consumer commit and tree, required workflow, job, fixed
provider app and check, successful conclusion, run ID, attempt, exact head SHA,
unique run-and-attempt-named artifact created during the required job, archive
byte count and digest, receipt path, receipt digest, and parsed receipt. The
receipt produced before upload contains no provider-assigned artifact ID or
archive digest; those values belong to the post-run reconciliation. The
canonical validator retrieves these records and bytes through the authenticated
provider API, bounds response sizes and deadlines, and fails closed offline.
One absolute deadline covers the complete provider validation rather than
resetting for each request or page. Within one invocation, it authenticates
each unique exact hosted-evidence bundle once, then validates every candidate's
independent transition and receipt binding against that authenticated result.
Local or committed receipt bytes are diagnostic only. Compass's observational
consumer ledger is neither projected policy nor a consumer reconciliation
record or adoption evidence.

## Shared by authority, specialized by ownership

Universal doctrine comes from Compass. Repository-specific architecture,
product behavior, migrations, non-goals, commands, budgets, and procedures stay
owned by the repository. A repository may narrow or extend a shared procedure
for its own domain, but it does not independently redefine the shared rule.

Derived projected bytes are intentional: they make each checkout complete and
offline-capable. Their receipt and drift check preserve Compass as the authority.

## Skill authority and discovery

Compass owns the canonical regular files under `skills/<name>/` and the generic
projection conformance checker. Each repository owns how those canonical skills
are exposed to tool-specific discovery paths. A repository may use a proven
symlink adapter, a generated physical pointer or adapter, or a tool-native
configuration mechanism, provided the adapter contains no independent policy
and repository validation detects discovery or drift failures.

Tool-discovery adapters are outside Compass-managed namespaces and may be
symlinks when repository and tool policy permit them. Compass-managed projected
files and directories remain regular, non-symlink filesystem entries. Prose
that merely mentions a skill is documentation, not mechanical discovery, and
is insufficient for a tool that requires a discovery path or adapter.
