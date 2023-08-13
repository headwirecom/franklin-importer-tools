import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import ExcelJS from 'exceljs';
import Path from 'path';
import fs from 'fs-extra';
import { Utils, html2docx } from '@adobe/helix-importer';
import getEntries from '../impl/entries.js';

function fixLinks(url, document, attrNames) {
    const protocol = new URL(url).protocol;
    for (let attrName of attrNames) {
        document.querySelectorAll(`[${attrName}]`).forEach((el) => {
            const val = el.getAttribute(attrName);
            if (val.startsWith('//')) {
                const newVal = `${protocol}${val}`;
                el.setAttribute(attrName, `${newVal}`);
            }
        });
    }
}

const command = 'import';
const desc = 'import site content';
const builder = {
    urls: {
        alias: 'u',
        describe: 'url or local path to json object containing the list of urls to import',
        required: true
    },
    transformScript: {
        alias: 'ts',
        describe: 'url or path to project specific DOM trasformation script',
        required: true
    },
    target: {
        alias: 't',
        describe: "local path to store import output",
        default: './docs'
    }
};

const absPath = (path) => {
    if (path.startsWith('/')) {
        return path;
    } else {
        const cwd = process.cwd();
        const absPath = Path.join(process.cwd(), path);
        return absPath;
    }
};

const documentPath = (targetDir, docPath) => {
    return Path.join(targetDir, docPath);
}

const saveFile = async (path, content) => {
    await fs.mkdirs(Path.dirname(path));
    await fs.writeFile(path, content);
}

const buildReport = async (importStatus) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Import Report');

    const headers = ['URL', 'file', 'status', 'redirect'].concat(importStatus.extraCols);

    // create Excel auto Filters for the first row / header
    worksheet.autoFilter = {
        from: 'A1',
        to: `${String.fromCharCode(65 + headers.length - 1)}1`, // 65 = 'A'...
    };

    worksheet.addRows([
        headers,
    ].concat(importStatus.rows.map((row) => {
        const {
            url, path, file, status, redirect, report,
        } = row;
        const extra = [];
        if (report) {
            importStatus.extraCols.forEach((col) => {
                const e = report[col];
                if (e) {
                    if (typeof e === 'string') {
                        if (e.startsWith('=')) {
                            extra.push({
                                formula: report[col].replace(/=/, '_xlfn.'),
                                value: '', // cannot compute a default value
                            });
                        } else {
                            extra.push(report[col]);
                        }
                    } else {
                        extra.push(JSON.stringify(report[col]));
                    }
                }
            });
        }

        return [url, file || '', status, redirect || ''].concat(extra);
    })));

    return workbook.xlsx.writeBuffer();
};

const saveReport = async (targetDir, importStatus) => {
    const reportFilePath = Path.join(targetDir,'import-report.xlsx');
    const blob = await buildReport(importStatus);
    await saveFile(reportFilePath, blob);
};

const handler = async (argv) => {
    const importStatus = {
        imported: 0,
        total: 0,
        rows: [],
        extraCols: []
    };

    const targetDir = absPath(argv.target);
    fs.ensureDir(targetDir);
    const tsPath = absPath(argv.transformScript);
    const projectTransformer = await import(tsPath);
    const entries = await getEntries(argv.urls);
    importStatus.total = entries.length;
    await Utils.asyncForEach(entries, async (url, index) => {
        importStatus.imported += 1;
        const resp = await fetch(url);
        if (resp.ok) {
            if (resp.redirected) {
                console.log(`${importStatus.imported}/${importStatus.total}. ${url} redirected`);
                importStatus.rows.push({
                    url,
                    status: 'Redirect',
                    redirect: resp.url
                });
            } else {
                try {
                    const text = await resp.text();
                    const doc = new JSDOM(text).window.document;
                    fixLinks(url, doc, ['srcset', 'src']);
                    const result = await html2docx(url, doc, projectTransformer, {}, {});
                    const path = WebImporter.FileUtils.sanitizePath(result.path);
                    const docPath = `${documentPath(targetDir, path)}.docx`;
                    saveFile(docPath, result.docx);
                    console.log(`${importStatus.imported}/${importStatus.total}. ${url} ok`);
                    const report = (result.report) ? result.report : {};
                    Object.keys(report).forEach((key) => {
                        if (!importStatus.extraCols.includes(key)) {
                          importStatus.extraCols.push(key);
                        }
                    });
                    importStatus.rows.push({
                        url,
                        status: 'Success',
                        file: docPath,
                        report
                    });
                } catch(error) {
                    console.error(error);
                    importStatus.rows.push({
                        url,
                        status: `Error: ${error.message}`
                    });
                }
            }
        } else {
            console.log(`${importStatus.imported}/${importStatus.total}. ${url} return status ${resp.status}`);
            importStatus.rows.push({
                url,
                status: `Invalid: ${resp.status}`,
            });
        }
    });

    console.log('Done! Saving report.');
    await saveReport(targetDir, importStatus);
};

export default {
    command,
    desc,
    builder,
    handler
}