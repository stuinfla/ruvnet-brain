#!/usr/bin/env node
import { developerUpdateCli } from '../plugin/scripts/developer-update.mjs';
developerUpdateCli().catch(error => { console.error(error.message); process.exitCode = 1; });
