import fetch from 'node-fetch';
import fs from 'fs';

async function getEntries(url) {
    if (url.startsWith('https://') || url.startsWith('http://')) {
        const res = await fetch(url);
        if (res.ok) {
            const json = await res.json();
            return json;
        }
    } else {
        const f = fs.readFileSync(url);
        const json = JSON.parse(f);
        return json;
    }
    
    return [];
}

export default getEntries;