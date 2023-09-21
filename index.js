#!/usr/bin/env node

import { DOMUtils, Blocks, FileUtils } from '@adobe/helix-importer';
import { JSDOM } from 'jsdom';
import yargs from 'yargs';
import importCommand from './src/cmds/import.js';
import uploadCommand from './src/cmds/upload.js';
import fetch from 'node-fetch';

global.WebImporter = {
    Blocks,
    DOMUtils,
    FileUtils
};

global.JSDOM = JSDOM;
global.window = new JSDOM('').window;
global.document = global.window.document;
global.fetch = fetch;
  
await yargs(process.argv.slice(2))
    .command(importCommand)
    .command(uploadCommand).demandCommand(1).help().argv;