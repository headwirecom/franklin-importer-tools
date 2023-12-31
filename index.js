#!/usr/bin/env node

import { DOMUtils, Blocks, FileUtils } from '@adobe/helix-importer';
import { JSDOM } from 'jsdom';
import yargs from 'yargs';
import importCommand from './src/cmds/import.js';
import uploadCommand from './src/cmds/upload.js';
import publishCommand from './src/cmds/publish.js';
import urlsCommand from './src/cmds/urls.js';
import fetch from '@adobe/node-fetch-retry';

const _command = process.argv.slice(2);

if (_command[0] === 'import') {
    global.WebImporter = {
        Blocks,
        DOMUtils,
        FileUtils
    };

    global.JSDOM = JSDOM;
    global.window = new JSDOM('').window;
    global.document = global.window.document;
    global.fetch = fetch;
}
  
await yargs(_command)
    .command(importCommand)
    .command(uploadCommand)
    .command(publishCommand)
    .command(urlsCommand).demandCommand(1).help().argv;