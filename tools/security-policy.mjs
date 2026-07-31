// The single machine-readable source of security-hygiene POLICY: SLA tables,
// per-repository expected sources, GitHub App token scopes, report exit codes,
// and the managed issue-label state machine. The report consumes this; tests
// bind it to workflows plus the README and runbook. Change policy here and its
// tested human rendering together — nowhere else.

// Days to resolve, by severity, per source. Dependabot severities are
// advisory severities; code scanning prefers the security severity and falls
// back to the tool level (error/warning/note). An open secret-scanning alert
// is urgent regardless of age: a possibly live credential needs rotation now.
export const DEPENDABOT_SLA = { critical: 1, high: 7, medium: 30, low: 90 }
export const CODE_SCANNING_SLA = {
  critical: 1,
  high: 7,
  medium: 30,
  low: 90,
  error: 7,
  warning: 14,
  note: 30,
}
export const UNKNOWN_SEVERITY_SLA_DAYS = 7 // unknown severity is triaged like high

// Which sources each repository is REQUIRED to have readable. "A scanner is
// disabled" is only acceptable where this policy says so — otherwise a
// disabled scanner is a coverage regression the monitor must catch, not a
// state to infer from an API message. roost is private without Advanced
// Security, so its scanning features are expected-disabled until the plan
// changes; flip them to "required" here when it does.
export const SOURCE_POLICY = {
  'jasondockery/renovate-config': {
    dependabot: 'required',
    codeScanning: 'required',
    secretScanning: 'required',
  },
  'jasondockery/groundwork': {
    dependabot: 'required',
    codeScanning: 'required',
    secretScanning: 'required',
  },
  'jasondockery/roost': {
    dependabot: 'required',
    codeScanning: 'expected-disabled',
    secretScanning: 'expected-disabled',
  },
}

export const MANAGED_STATE_LABELS = ['security-overdue', 'security-monitor-broken']

// Exact GitHub App token scopes requested by each workflow. The installation
// must grant their union, while each minted token receives only its lane's
// subset. Members: read is intentionally absent: this deployment does not
// assign teams or use organization-member lookup.
export const RENOVATE_APP_PERMISSIONS = {
  administration: 'read',
  checks: 'write',
  contents: 'write',
  issues: 'write',
  metadata: 'read',
  'pull-requests': 'write',
  statuses: 'write',
  'vulnerability-alerts': 'read',
  workflows: 'write',
}

export const HYGIENE_APP_PERMISSIONS = {
  dependabot: {
    metadata: 'read',
    'vulnerability-alerts': 'read',
  },
  codeScanning: {
    metadata: 'read',
    'security-events': 'read',
  },
  secretScanning: {
    metadata: 'read',
    'secret-scanning-alerts': 'read',
  },
}

// Canonical report-command exit contract. The workflow captures 2 and 3 so it
// can deliver the report before failing enforcement; 1 and 64 fail immediately.
export const REPORT_EXIT_CODES = {
  success: 0,
  runtimeFailure: 1,
  overdue: 2,
  monitorBroken: 3,
  usage: 64,
}

// The complete desired label set for the durable issue, as a pure function so
// every transition (clean→overdue, overdue→clean, clean→broken,
// broken→overdue, both→clean) is unit-provable. Labels this lane does not
// manage are preserved; broken and overdue are independent facts and can both
// be present.
export function desiredLabels(currentLabels, { monitorBroken, overdueCount }) {
  const kept = currentLabels.filter((label) => !MANAGED_STATE_LABELS.includes(label))
  if (!kept.includes('security-hygiene')) kept.push('security-hygiene')
  if (overdueCount > 0) kept.push('security-overdue')
  if (monitorBroken) kept.push('security-monitor-broken')
  return [...kept].sort()
}
