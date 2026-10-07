import type { DemoApplication, HostingNode } from './types';

// The four reference applications. The same decentralization layer protects
// each one — only the parties, thresholds and privileged action change.
// This is the point of the project: policy, approval, resilience and audit
// are reusable infrastructure, not features of a single treasury app.

// Hosting node sets. `slug` maps a node to the allocated Canton party that
// hosts it (daml/Init.daml); that operator reports its own status on-ledger.
const SMALL_HOST: HostingNode[] = [
  { id: 'a', label: 'Node A', operator: 'Operator Alpha', slug: 'opalpha' },
  { id: 'b', label: 'Node B', operator: 'Operator Beta', slug: 'opbeta' },
  { id: 'c', label: 'Node C', operator: 'Operator Gamma', slug: 'opgamma' },
];

const LARGE_HOST: HostingNode[] = [
  ...SMALL_HOST,
  { id: 'd', label: 'Node D', operator: 'Operator Delta', slug: 'opdelta' },
  { id: 'e', label: 'Node E', operator: 'Operator Epsilon', slug: 'opepsilon' },
];

export const APPLICATIONS: DemoApplication[] = [
  {
    id: 'treasury',
    name: 'Treasury',
    icon: 'treasury',
    summary: 'Threshold-controlled movement of institutional funds.',
    parties: [
      { id: 'alice', name: 'Alice', role: 'Treasury Operator' },
      { id: 'bob', name: 'Bob', role: 'Treasury Operator' },
      { id: 'carol', name: 'Carol', role: 'Risk Officer' },
    ],
    threshold: 2,
    hostingNodes: SMALL_HOST,
    hostingThreshold: 2,
    action: {
      verb: 'TRANSFER',
      title: 'Send 50,000 CC',
      primary: '50,000 CC',
      from: 'Greylabs Treasury',
      to: 'vendor::party',
      detail: 'Outbound vendor payment from the institutional treasury.',
      reference: 'REQ-1042',
    },
  },
  {
    id: 'token',
    name: 'Token Administration',
    icon: 'token',
    summary: 'Govern supply-changing operations such as mint and burn.',
    parties: [
      { id: 'alice', name: 'Alice', role: 'Issuer' },
      { id: 'bob', name: 'Bob', role: 'Issuer' },
      { id: 'carol', name: 'Carol', role: 'Compliance' },
      { id: 'dave', name: 'Dave', role: 'Board Delegate' },
    ],
    threshold: 3,
    hostingNodes: SMALL_HOST,
    hostingThreshold: 2,
    action: {
      verb: 'MINT',
      title: 'Mint 1,000,000 units',
      primary: '1,000,000 GLX',
      from: 'GLX Issuer',
      to: 'circulating supply',
      detail: 'Increase circulating token supply by one million units.',
      reference: 'MINT-208',
    },
  },
  {
    id: 'trading',
    name: 'Trading Administration',
    icon: 'trading',
    summary: 'Protect market parameters that affect every participant.',
    parties: [
      { id: 'alice', name: 'Alice', role: 'Market Operator' },
      { id: 'bob', name: 'Bob', role: 'Market Operator' },
      { id: 'carol', name: 'Carol', role: 'Oversight' },
    ],
    threshold: 2,
    hostingNodes: SMALL_HOST,
    hostingThreshold: 2,
    action: {
      verb: 'SET FEE',
      title: 'Change fee 10 bps → 25 bps',
      primary: '10 → 25 bps',
      from: 'GLX/CC market',
      to: 'all participants',
      detail: 'Raise the venue trading fee applied to every fill.',
      reference: 'PARAM-77',
    },
  },
  {
    id: 'governance',
    name: 'Protocol Governance',
    icon: 'governance',
    summary: 'Control privileged protocol operations under strict quorum.',
    parties: [
      { id: 'alice', name: 'Alice', role: 'Council' },
      { id: 'bob', name: 'Bob', role: 'Council' },
      { id: 'carol', name: 'Carol', role: 'Council' },
      { id: 'dave', name: 'Dave', role: 'Council' },
      { id: 'erin', name: 'Erin', role: 'Council' },
    ],
    threshold: 3,
    hostingNodes: LARGE_HOST,
    hostingThreshold: 3,
    action: {
      verb: 'PAUSE',
      title: 'Pause application',
      primary: 'EMERGENCY PAUSE',
      from: 'Protocol core',
      to: 'all modules',
      detail: 'Halt all protocol activity pending council review.',
      reference: 'GOV-15',
    },
  },
];

export const getApplication = (id: string): DemoApplication =>
  APPLICATIONS.find((a) => a.id === id) ?? APPLICATIONS[0];
