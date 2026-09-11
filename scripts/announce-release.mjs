#!/usr/bin/env node
/**
 * scripts/announce-release.mjs — ADR-078 Release Announcer
 *
 * Posts release announcement to Slack webhook
 *
 * Usage:
 *   SLACK_WEBHOOK_RELEASES=https://... node scripts/announce-release.mjs v3.4.19
 *
 * Environment variables:
 *   SLACK_WEBHOOK_RELEASES  Slack webhook URL for #releases channel
 *   DRY_RUN                 If set, print payload without posting
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { URL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] || process.env.VERSION;
const webhook = process.env.SLACK_WEBHOOK_RELEASES;
const dryRun = process.env.DRY_RUN === 'true';

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function ok(message) {
  console.log(`✓ ${message}`);
}

if (!version) {
  die('version not provided (usage: announce-release.mjs v3.4.19)');
}

if (!webhook && !dryRun) {
  die('SLACK_WEBHOOK_RELEASES environment variable not set');
}

// Read CHANGELOG to extract version notes
let changelogExcerpt = 'See CHANGELOG.md for details.';
try {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    const lines = changelog.split('\n');

    // Find the version section and extract next 10 lines
    let capturing = false;
    let excerpt = [];
    for (const line of lines) {
      if (line.includes(`[${version.replace(/^v/, '')}]`)) {
        capturing = true;
        continue;
      }
      if (capturing) {
        if (line.startsWith('## [')) break; // Next version
        if (line.trim()) excerpt.push(line);
        if (excerpt.length >= 10) break;
      }
    }

    if (excerpt.length > 0) {
      changelogExcerpt = excerpt.join('\n').slice(0, 500);
    }
  }
} catch (error) {
  // Silently ignore errors reading changelog
}

// Build Slack message payload
const payload = {
  text: `📦 RuvNet Brain ${version} released!`,
  blocks: [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `📦 RuvNet Brain ${version}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*New release is live on npm*\n\n<https://www.npmjs.com/package/ruvnet-brain/v${version.replace(/^v/, '')}|View on npm>`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Installation*\`\`\`bash\nnpm install -g ruvnet-brain@latest\n\`\`\``,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Changes*\n${changelogExcerpt}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View Release on GitHub',
            emoji: true,
          },
          url: `https://github.com/stuinfla/ruvnet-brain/releases/tag/${version}`,
          action_id: 'release_github',
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View on npm',
            emoji: true,
          },
          url: `https://www.npmjs.com/package/ruvnet-brain/v${version.replace(/^v/, '')}`,
          action_id: 'release_npm',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Released at ${new Date().toISOString()}`,
        },
      ],
    },
  ],
};

if (dryRun) {
  console.log('\n=== DRY RUN: Slack Announcement ===\n');
  console.log(JSON.stringify(payload, null, 2));
  console.log('\n=== END DRY RUN ===\n');
  process.exit(0);
}

// Post to Slack
function postToSlack() {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(webhook);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': JSON.stringify(payload).length,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(
              new Error(
                `Slack returned ${res.statusCode}: ${data}`
              )
            );
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

postToSlack()
  .then(() => {
    ok(`Posted release announcement to Slack (#releases)`);
    console.log(`\n  Version: ${version}`);
    console.log(`  npm: https://www.npmjs.com/package/ruvnet-brain`);
    console.log(`\n`);
  })
  .catch((error) => {
    die(`failed to post to Slack: ${error.message}`);
  });
