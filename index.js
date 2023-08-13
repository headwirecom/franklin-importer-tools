#!/usr/bin/env node

import { DOMUtils, Blocks, FileUtils } from '@adobe/helix-importer';
import { JSDOM } from 'jsdom';
import yargs from 'yargs';
import importCommand from './src/cmds/import.js'

global.WebImporter = {
    Blocks,
    DOMUtils,
    FileUtils
};

global.window = new JSDOM('').window;
global.document = global.window.document;
  
yargs(process.argv.slice(2)).command(importCommand).demandCommand(1).help().argv;