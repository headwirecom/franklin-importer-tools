import fetch from '@adobe/node-fetch-retry';
import { JSDOM } from 'jsdom';
import ExcelJS from 'exceljs';
import Path, { resolve } from 'path';
import fs from 'fs-extra';
import { Utils, html2docx, html2md } from '@adobe/helix-importer';
import ConcurrencyUtil from '../impl/ConcurrencyUtil.js'
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
    },
    async: {
        description: "number of documents to import asynchronously",
        type: "number",
        default: 1
    },
    asyncPause: {
        description: "number of milliseconds to pause import before continueing asynchronous processing",
        type: "number",
        default: 200
    },
    start: {
        description: "starting index to import from URL list",
        type: "number"
    },
    end: {
        description: "end index to import from URL list",
        type: "number"
    },
    report: {
        description: "report name",
        default: "import-report"
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

const writeReportWorksheet = (worksheet, importStatus) => {
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
}

const buildReport = async (importStatus, filePath) => {
    const workbook = new ExcelJS.Workbook();
    let worksheet = null;
    if (fs.existsSync(filePath)) {
        workbook.xlsx.readFile(filePath).then(() => {
            worksheet = workbook.getWorksheet(1);
            writeReportWorksheet(worksheet, importStatus);
            workbook.xlsx.writeFile(filePath);
        }).catch((error) => {
            console.error(`Unable to save import report ${filePath}`, error);
        });
    } else {
        worksheet = workbook.addWorksheet('Import Report');
        writeReportWorksheet(worksheet, importStatus);
        workbook.xlsx.writeFile(filePath);
    }
};

const saveReport = async (importStatus, name) => {
    const reportFilePath = Path.join(importStatus.targetDir,`${name}.xlsx`);
    try {
        await buildReport(importStatus, reportFilePath);
    } catch (error) {
        console.error(`Unable to save import report ${reportFilePath}`, error);
    }
    // const blob = await buildReport(importStatus);
    //await saveFile(reportFilePath, blob);
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

const processUrl = async (url, importStatus, index) => {
    // console.log(`${(index + 1)}/${importStatus.total}. Processing ${url}`);
    let outputTypes = importStatus.outputTypes;
    let targetDir = importStatus.targetDir;
    const resp = await fetch(url);
    if (resp.ok) {
        if (resp.redirected) {
            importStatus.imported += 1;
            console.log(`${importStatus.imported}/${importStatus.total}. ${url} redirected`);
            importStatus.rows.push({
                url,
                status: 'Redirect',
                redirect: resp.url
            });
        } else {
            let currentWindow = null;
            try {
                const text = await resp.text();
                currentWindow = new JSDOM(text).window;
                const doc = currentWindow.document;
                fixLinks(url, doc, ['srcset', 'src']);
                const config = { toMd: outputTypes.includes('md'), toDocx: outputTypes.includes('docx') };
                const result = await htmlTo(url, doc, importStatus.projectTransformer, config, importStatus.params);
                const path = WebImporter.FileUtils.sanitizePath(result.path);
                const docPath = `${documentPath(targetDir, path)}`;
                const files = await saveOutput(docPath, outputTypes, result);
                updateTimer(importStatus);
                importStatus.imported += 1;
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
                importStatus.imported += 1;
                console.error(error);
                importStatus.rows.push({
                    url,
                    status: `Error: ${error.message}`
                });
            } finally {
                if (currentWindow) {
                    currentWindow.close();
                }
            }
        }
    } else {
        importStatus.imported += 1;
        console.log(`${importStatus.imported}/${importStatus.total}. ${url} return status ${resp.status}`);
        importStatus.rows.push({
            url,
            status: `Invalid: ${resp.status}`,
        });
    }
}

const testFetch = async (url, importStatus, index, array) => {
    let remaining = array.length;
    const resp = await fetch(url);
    importStatus.imported += 1;
    updateTimer(importStatus);
    importStatus.rows.push({ url, status: `${resp.status}`});
    console.log(`(${index}/${remaining}) -> ${importStatus.imported}/${importStatus.total}. Test fetch ${url} return status ${resp.status}. Elapsed time: ${importStatus.timeStr}`);
}

const handler = async (argv) => {
    const importStatus = {
        imported: 0,
        total: 0,
        rows: [],
        extraCols: []
    };

    const outputTypes = argv.type.split('|');
    const concurrency = argv.async;
    const delay = argv.asyncPause;
    const report = argv.report;
    validateOutputType(outputTypes);
    importStatus.outputTypes = outputTypes;
    importStatus.targetDir = absPath(argv.target);
    fs.ensureDir(importStatus.targetDir);
    const tsPath = absPath(argv.transformScript);
    importStatus.projectTransformer = await import(tsPath);
    const entries = await getEntries(argv.urls, argv.start, argv.end);
    importStatus.params = (argv.params) ? await asJson(argv.params) : {};
    importStatus.total = entries.length;
    importStatus.startTime = Date.now();

    const asyncCallback = async (url, status, index, array) => {
        return new Promise(async (resolve) => {
            try {
                // await testFetch(url, status, index, array);
                await processUrl(url, status, index);
            } catch(error) {
                if (status.imported <= index) {
                    status.imported = index + 1;
                }
                console.error(error);
                importStatus.rows.push({
                    url,
                    status: `Error: ${error.message}`
                });
            }
            resolve();
        });
    }

    if (entries.length > 0) {
        console.profile();
        if (concurrency < 1) {
            // async processing is off
            console.log('async processing is off');
            await Utils.asyncForEach(entries, async (url, index) => {
                await processUrl(url, importStatus, index);
            });
        } else {
            await ConcurrencyUtil.processAll(entries, asyncCallback, importStatus, concurrency, delay);
        }
        let waitCount = 0;
        ConcurrencyUtil.waitFor(3000, () => { 
            waitCount++;
            if (importStatus.imported === importStatus.total || waitCount >= 100) {
                // console.log(`${waitCount}) ${importStatus.imported}/${importStatus.total}`);
                return true; 
            }
            return false;
        }, 
        async () => {
            console.log('Saving report !');
            await saveReport(importStatus, report);
            updateTimer(importStatus);
            console.log(`Done! Imported ${importStatus.imported} documents in ${importStatus.timeStr}`);
            console.profileEnd();
            // process.exit();
        });
    } 
};

export default {
    command,
    desc,
    builder,
    handler
}