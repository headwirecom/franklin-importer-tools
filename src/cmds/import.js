import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import ExcelJS from 'exceljs';
import Path from 'path';
import fs from 'fs-extra';
import { Utils, html2docx, html2md } from '@adobe/helix-importer';
import getEntries from '../impl/entries.js';
import { asJson } from '../impl/args.js'

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
        describe: 'url or local path to json file containing the list of urls to import',
        required: true
    },
    transformScript: {
        alias: 'ts',
        describe: 'url or path to project specific DOM trasformation script',
        required: true
    },
    target: {
        alias: 't',
        describe: 'local path to store import output',
        default: './docs'
    },
    type: {
        description: "file type (md or docx, or \"md|docx\" for both) for saving output",
        default: "docx"
    },
    params: {
        alias: 'p',
        description: 'parameters to pass to DOM trasformation script',
        default: '{}'
    }
};

const validateOutputType = (types) => {
    for (let t of types) {
        switch (t) {
            case "docx": break;
            case "md": break;
            default:
                throw new Error(`Invalid file type "${t}"`);
        }
    }
}

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

const saveOutput = async (path, types, result) => {
    let savedFiles = [];
    for (let t of types) {
        if (t in result) {
            let filePath = `${path}.${t}`;
            await saveFile(`${filePath}`, result[t]);
            savedFiles.push(filePath);
        }
    }
    return savedFiles;
}

const buildReport = async (importStatus) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Import Report');

    const headers = ['URL', 'path', 'file', 'status', 'redirect'].concat(importStatus.extraCols);

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

        return [url, path, file || '', status, redirect || ''].concat(extra);
    })));

    return workbook.xlsx.writeBuffer();
};

const saveReport = async (importStatus) => {
    const reportFilePath = Path.join(importStatus.targetDir,'import-report.xlsx');
    const blob = await buildReport(importStatus);
    await saveFile(reportFilePath, blob);
};

const htmlTo = async (url, doc, projectTransformer, config, params) => {
    if (config.toDocx) {
        // this will return both outputs
        return await html2docx(url, doc, projectTransformer, config, params);
    }
    // md output only
    return await html2md(url, doc, projectTransformer, config, params);
}

const updateTimer = (importStatus) => {
    const totalTime = Math.round((new Date() - importStatus.startTime) / 1000);
    let timeStr = `${totalTime}s`;
    if (totalTime > 60) {
      timeStr = `${Math.round(totalTime / 60)}m ${totalTime % 60}s`;
      if (totalTime > 3600) {
        timeStr = `${Math.round(totalTime / 3600)}h ${Math.round((totalTime % 3600) / 60)}m`;
      }
    }
    importStatus.timeStr = timeStr;
}

const processUrl = async (url, importStatus) => {
    let outputTypes = importStatus.outputTypes;
    let targetDir = importStatus.targetDir;
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
                // console.log(`${importStatus.imported}/${importStatus.total}. Processing ${url}`);
                const config = { toMd: outputTypes.includes('md'), toDocx: outputTypes.includes('docx') };
                const result = await htmlTo(url, doc, importStatus.projectTransformer, config, importStatus.params);
                const path = WebImporter.FileUtils.sanitizePath(result.path);
                const docPath = `${documentPath(targetDir, path)}`;
                const files = await saveOutput(docPath, outputTypes, result);
                updateTimer(importStatus);
                console.log(`${importStatus.imported}/${importStatus.total}. Imported ${url}. Elapsed time: ${importStatus.timeStr}`);
                const report = (result.report) ? result.report : {};
                Object.keys(report).forEach((key) => {
                    if (!importStatus.extraCols.includes(key)) {
                      importStatus.extraCols.push(key);
                    }
                });
                for (let file of files) {
                    importStatus.rows.push({
                        url,
                        status: 'Success',
                        path: docPath,
                        file,
                        report
                    });
                }
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
}

const handler = async (argv) => {
    const importStatus = {
        imported: 0,
        total: 0,
        rows: [],
        extraCols: []
    };

    const outputTypes = argv.type.split('|');
    validateOutputType(outputTypes);
    importStatus.outputTypes = outputTypes;
    importStatus.targetDir = absPath(argv.target);
    fs.ensureDir(importStatus.targetDir);
    const tsPath = absPath(argv.transformScript);
    importStatus.projectTransformer = await import(tsPath);
    const entries = await getEntries(argv.urls);
    importStatus.params = (argv.params) ? await asJson(argv.params) : {};
    importStatus.total = entries.length;
    importStatus.startTime = Date.now();
    await Utils.asyncForEach(entries, async (url, index) => {
        importStatus.imported += 1;
        try {
            await processUrl(url, importStatus)
        } catch(error) {
            console.error(error);
            importStatus.rows.push({
                url,
                status: `Error: ${error.message}`
            });
        }
    });

    console.log('Done! Saving report.');
    await saveReport(importStatus);
};

export default {
    command,
    desc,
    builder,
    handler
}