import { describe, expect, it } from 'vitest';
import { isSourceDiscoveryIntent } from '../../kb/source-discovery-intent.mjs';

describe('reviewed source discovery intent', () => {
  it.each([
    'Find local vector-storage options',
    'What are my local vector-storage options without a server?',
    'What can I use to keep and search embeddings locally in a browser without a backend service?',
    'What should I use to store vectors locally and privately with zero servers?',
    'How should I store embeddings in this project without running a server?',
    'How can I store embeddings locally without a server?',
    'How can agents carry useful learning from one project to another?',
  ])('allows broad discovery: %s', query => expect(isSourceDiscoveryIntent(query)).toBe(true));

  it.each([
    'Show me the implementation for storing embeddings locally.',
    'Does Ruflo provide automatic transfer of learning between projects?',
    'How do I prevent agents from sharing learned patterns across projects?',
    'Can agents automatically share learned patterns across projects without credentials?',
    'What API imports patterns from an IPFS CID?',
    'How can agents prevent transfer of learned patterns between projects?',
    'How can agents implement automatic transfer of learned patterns between projects?',
    'Find a way to prevent agents from sharing learned patterns across projects.',
    'Does this work without network access or credentials for cross-project transfer?',
  ])('keeps implementation, assertion, and troubleshooting questions on primary retrieval: %s', query =>
    expect(isSourceDiscoveryIntent(query)).toBe(false));
});
