---
name: shift-to-authority
description: Move reusable cross-repository concerns to the canonical authority whose declared scope and lifecycle can maintain them. Use for substantial engineering reviews, field failures, cross-repository coordination, and release, projection, or adoption handoffs.
---

# Shift to Authority

Move a recurring standard, contract, implementation, or proof requirement from
consumers to the canonical owner best positioned to maintain it.

Before classifying or reporting, load the projected `authority-policy.json` and
`authority-registry.json`. Treat the policy as normative for terms, scopes,
states, relationships, review classes, and new-authority prerequisites. Treat
the registry as authority-owned candidate and issuance truth. Do not copy those
tables into product policy.

Validate authority records with the projected dependency-free command:

```text
node .compass/check-authority-record.mjs \
  --policy .compass/authority-policy.json \
  --registry .compass/authority-registry.json
```

Direct consumers create and own their reconciliation record from
`consumer-reconciliation.schema.json`, then validate it with the same tool and
`--consumer <record>`. A projected registry never supplies a shared consumer
state, and Compass's observational `consumers.json` never substitutes for local
adoption evidence.

## Decide and repair

Repair an urgent local defect immediately. The repair may implement the
smallest safe behavior, but it must not establish a competing shared authority.
Shift to Authority must not launder, delay, or block that repair.

Ask whether the concern recurs, affects multiple or generated consumers, fits
an existing authority's declared scope, is stable rather than experimental,
and can be tested generically at that layer. Compass candidates must remain
independent of product, framework, provider, and deployment choices. Importance
or reuse within one existing authority does not create a candidate; when that
authority owns every finding, report `none` and keep the work there.

Do not strand qualifying generic doctrine as independently maintained consumer
policy. Do not move product APIs, routes, framework or library choices,
provider adapters, supported-platform mechanics, generated implementation,
dependency automation, or deployed acceptance outside the authority that owns
that layer. A new authority requires every prerequisite in the normative policy
and an explicit owner decision; nomination never creates a repository.

## Advance and issue

Follow the lifecycle from the normative policy. Keep authority candidate state
and each consumer's state in different records. An issued candidate must bind
the containing artifact receipt's exact seven-dimensional identity and must
record completed authority incorporation and reconciliation. Ordered transition
history preserves prior states; the current record never pretends a historical
nomination is current.

Consumer movement is prohibited until an issued identity-bound handoff exists.
Silence, dirty working bytes, another consumer's result, or a mechanically green
identity on an adoption hold is not acceptance or adoption. Once an issued
change is adopted, reconcile provisional duplicated policy locally.

## Report

Emit exactly one `Shift to Authority candidates` field for the review classes
listed in the normative policy. Small reviews and ordinary status messages do
not require the field. When none qualify, emit only:

```text
Shift to Authority candidates:
- none
```

For candidates, generate the current field list instead of copying a template:

```text
node .compass/check-authority-record.mjs \
  --policy .compass/authority-policy.json \
  --print-review-template
```

Never combine `none` with candidates. Preserve the stable `sta-...` ID and
record honest local repair and local reconciliation status.

## Reconcile relationships

Every actual consumer owns one record conforming to the projected consumer
schema. A direct relationship binds the exact Compass identity. A relationship
through another authority binds that upstream authority's exact identity and
does not claim direct Compass adoption. A truly inapplicable relationship gives
an exact reason. Deferred work requires the schema's owner-bound disposition
and never claims adoption or conformance.

Hatch relates to Compass through Roost, not by direct Compass projection.
