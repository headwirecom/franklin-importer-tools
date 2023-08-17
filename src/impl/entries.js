import fetch from 'node-fetch';
import fs from 'fs';
import { asJson } from './args.js'

async function getEntries(arg) {
    return await asJson(arg, 'urls');
}

export default getEntries;