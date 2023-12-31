import fetch from '@adobe/node-fetch-retry';
import { JSDOM } from 'jsdom';
import zlib from 'zlib';
import fs from 'fs';
import { asJson, tryJSON } from '../impl/args.js';
import { absPath } from '../impl/filesystem.js';
import ConcurrencyUtil from '../impl/ConcurrencyUtil.js';

let totalCounter = 0;
let startTime = Date.now();

const updateTimer = () => {
    const totalTime = Math.round((new Date() - startTime) / 1000);
    let timeStr = `${totalTime}s`;
    if (totalTime > 60) {
      timeStr = `${Math.round(totalTime / 60)}m ${totalTime % 60}s`;
      if (totalTime > 3600) {
        timeStr = `${Math.round(totalTime / 3600)}h ${Math.round((totalTime % 3600) / 60)}m`;
      }
    }
    timeStr = timeStr;
    return timeStr;
}

const decompress = async (blob) => {
    return new Promise((reslove, reject) => {
        zlib.gunzip(blob, (err, decompressedData) => {
            if (err) {
                reject(err);
                return;
            }
            const text = decompressedData.toString();
            // console.log(text);
            reslove(text);
        });
    });
}

const fetchSitemap = async (path, callback, timeFilter) => {
    const resp = await fetch(path);
    if (!resp.ok) {
        return null;
    }

    if (path.endsWith('.gz')) {
        const blob = await resp.blob();
        const buf = await blob.arrayBuffer()
        const text = await decompress(buf);
        await parseSitemap(text, callback, timeFilter);
    } else {
        const text = await resp.text();
        await parseSitemap(text, callback, timeFilter);
    }
}

const parseSitemap = async (sitemap, callback, timeFilter) => {
    const text = sitemap;

    const doc = new JSDOM(text).window.document;
    const sitemaps = [...doc.querySelectorAll('sitemap')];
    const links = [...doc.querySelectorAll('url')];

    for(const sitemap of sitemaps) {
        const url = sitemap.querySelector('loc').childNodes[0].nodeValue;
        await fetchSitemap(url, callback, timeFilter);
    }

    await ConcurrencyUtil.processAll(links, async (el) => {
        const loc = el.querySelector('loc').childNodes[0].nodeValue;
        const lastmod = el.querySelector('lastmod').childNodes[0].nodeValue;
        const pass = (timeFilter) ? new Date(lastmod).getTime() > timeFilter.getTime() : true; 
        if (pass) {
            await callback(loc);
        }
    }, {}, 10, 1000, true);
}

const command = 'urls';
const desc = 'get a list of URLs for import';

const builder = {
    source: {
        alias: 's',
        describe: 'sitemap URL',
        required: true
    },
    out: {
        alias: 'o',
        describe: 'Output file path. If the file path ends with .json write a JSON array. If not specified print to console.'
    },
    mappingScript: {
        describe: `Optional URL mapping script. Project specific URL mapping script to map each URL (example: shortened to full path). \n
                    The script should implement a single map(url, params) method and return a mapped URL.`
    },
    mappingScriptParams: {
        describe: 'Custom parameters to pass to project specific mapping script.'
    },
    lastmod: {
        alias: 't',
        describe: 'The last modified date filer. This is compared to lastmod date in the sitemap.'
    }
}

const handler = async (argv) => {
    const sitemapURL = argv.source;
    let mappingScript = null;
    let mappingScriptParams = null;

    if (argv.mappingScript) {
        mappingScript= await import(absPath(argv.mappingScript));

        if (argv.mappingScriptParams) {
            mappingScriptParams = await asJson(argv.mappingScriptParams);
        }
    }

    console.log(`Getting URLs from sitemap ${sitemapURL}`);
    try {
        const hostname = new URL(sitemapURL).hostname
        const filePath = argv.out;
        const isJsonOut = (filePath && filePath.endsWith('.json'));
        if (filePath) {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            if (isJsonOut) {
                console.log(`Writing JSON array to ${filePath}`);
                fs.appendFileSync(filePath, '[\n');
            } else {
                console.log(`Writing output to ${filePath}`);
            }
        }

        const timeFilter = (argv.lastmod) ? new Date(argv.lastmod) : null;
        startTime = Date.now();
        await fetchSitemap(sitemapURL, async (path) => {
            const url = new URL(path);

            let mappedPath = `${url.protocol}//${hostname}${url.pathname}`;

            if (mappingScript) {
                mappedPath = await mappingScript.map(mappedPath, mappingScriptParams);
            }

            if (mappedPath) {
                if (filePath) {
                    if (isJsonOut) {
                        if (totalCounter > 0) {
                            fs.appendFileSync(filePath, ',\n');
                        }
                        if (tryJSON(mappedPath)) {
                            fs.appendFileSync(filePath, `${mappedPath}`);
                        } else {
                            fs.appendFileSync(filePath, `"${mappedPath}"`);
                        }
                    } else {
                        fs.appendFileSync(filePath, `${mappedPath}\n`);
                    }
                } else {
                    console.log(`${mappedPath}`);
                }
                totalCounter++;
            }
        }, timeFilter);
        if (isJsonOut) {
            fs.appendFileSync(filePath, ']');
        }
        console.log(`Extracted ${totalCounter} in ${updateTimer()}`);
    } catch (err) {
        console.error(err);
    }
}

export default {
    command,
    desc,
    builder,
    handler
}