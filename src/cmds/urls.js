import fetch from '@adobe/node-fetch-retry';
import { JSDOM } from 'jsdom';
import { resolve } from 'path';
import zlib from 'zlib';
import fs from 'fs';

let totalCounter = 0;

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

const fetchSitemap = async (path, callback) => {
    const resp = await fetch(path);
    if (!resp.ok) {
        return null;
    }

    if (path.endsWith('.gz')) {
        const blob = await resp.blob();
        const buf = await blob.arrayBuffer()
        const text = await decompress(buf);
        await parseSitemap(text, callback);
    } else {
        const text = await resp.text();
        await parseSitemap(text, callback);
    }
}

const parseSitemap = async (sitemap, callback) => {
    const text = sitemap;

    const doc = new JSDOM(text).window.document;
    const sitemaps = [...doc.querySelectorAll('sitemap')];
    const links = [...doc.querySelectorAll('url')];

    for(const sitemap of sitemaps) {
        const url = sitemap.querySelector('loc').childNodes[0].nodeValue;
        await fetchSitemap(url, callback);
    }

    for(const el of links) {
        const loc = el.querySelector('loc').childNodes[0].nodeValue;
        const url = new URL(loc);
        callback(loc);
    }
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
    }
}

const handler = async (argv) => {
    const sitemapURL = argv.source;
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
        await fetchSitemap(sitemapURL, (path) => {
            const url = new URL(path);
            if (filePath) {
                if (isJsonOut) {
                    fs.appendFileSync(filePath, `"${url.protocol}//${hostname}${url.pathname}"\n`);
                } else {
                    fs.appendFileSync(filePath, `${url.protocol}//${hostname}${url.pathname}\n`);
                }
            } else {
                console.log(`${url.protocol}//${hostname}${url.pathname}`);
            }
        });
        if (isJsonOut) {
            fs.appendFileSync(filePath, ']');
        }
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