import fetch from 'node-fetch';
import fs from 'fs';
import { asJson } from './args.js'

function checkStart(entries, start) {
    if (start && start !== 'undefined') {
        if (start >= 0 && start < entries.length) {
            return start;
        } else {
            console.warn(`start index argument ${start} cannot be less than 0 and has to be less than number of entries ${entries.length}`);
        }
    }
    return 0;
}

function checkEnd(entries, start, end) {
    if (end && end !== 'undefined') {
        if (end > start && end <= entries.length) {
            return end;
        } else {
            console.warn(`end index argument ${end} cannot be less than start ${start} or greater than number of entries ${entries.length}`);
        }
    }
    return entries.length;
}

async function getEntries(arg, start, end) {
    let entries = await asJson(arg, 'urls');
    const startIndex = checkStart(entries, start);
    const endIndex = checkEnd(entries, startIndex, end);
    if (startIndex > 0 || endIndex < entries.length) {
        console.log(`process entries subset from ${startIndex} to ${endIndex} of ${entries.length}`);
        entries = entries.slice(startIndex, endIndex);
    }
    return entries;
}

export default getEntries;