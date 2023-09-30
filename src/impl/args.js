import fetch from '@adobe/node-fetch-retry';
import fs from 'fs';
import Path from 'path';

function tryJSON(arg) {
    try {
        const json = JSON.parse(arg);
        if (json) {
            return json;
        }
    } catch(e) {}
    return false;
}

/**
 * Returns json object loaded from arg string or file spesified by path or URL
 * 
 * @param {*} arg - can be a json string, file path or URL
 */
async function asJson(arg, argName) {
    let json = tryJSON(arg);
    if (json) {
        return json;
    }

    try {
        if (arg.startsWith('https://') || arg.startsWith('http://')) {
            const res = await fetch(arg);
            if (res.ok) {
                const json = await res.json();
                return json;
            }
        } else {
            const path = arg.startsWith('/') ? arg : Path.join(process.cwd(), arg);
            const f = fs.readFileSync(path);
            const json = JSON.parse(f);
            return json;
        }
    } catch(e) {}

    throw new Error(`Unable to load JSON for argument ${argName}. Must be valid JSON, or path or URL to a JSON file`);
}

export {
    asJson
}