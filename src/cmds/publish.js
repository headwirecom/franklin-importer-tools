import DriveAPI from '../impl/DriveAPI.js';
import ConcurrencyUtil from '../impl/ConcurrencyUtil.js';
import fetch from '@adobe/node-fetch-retry';

const VALID_OPERATIONS = [ 'preview', 'live', 'index', 'cache', 'status' ];
const VALID_METHODS = [ 'POST', 'GET', 'DELETE' ];

let counter = 0;
let errorCount = 0;
let startTime = Date.now();
let timerString = '';

function updateTimer() {
    const totalTime = Math.round((new Date() - startTime) / 1000);
    let timeStr = `${totalTime}s`;
    if (totalTime > 60) {
      timeStr = `${Math.round(totalTime / 60)}m ${totalTime % 60}s`;
      if (totalTime > 3600) {
        timeStr = `${Math.round(totalTime / 3600)}h ${Math.round((totalTime % 3600) / 60)}m`;
      }
    }
    timerString = timeStr;
    return timerString;
}

function logIndexResponse(path, text) {
    const json = JSON.parse(text);
    const indeces = json.results;
    let logTxt = `${counter}. ${path}`;
    indeces.forEach((index) => {
      const record = (index.record) ? index.record : index;  
      if (record) {
        let indexRecord = JSON.stringify(record);
        logTxt = logTxt + ` Index name "${index.name}": ${indexRecord} ${updateTimer()}`;
      }
    });
    console.log(logTxt);
}

function logApiResponse(path, text) {
    const json = JSON.parse(text);
    let statusTxt = '{ ';
    for (let key of Object.keys(json)) {
      if (json[key].status && key !== 'links') {
        statusTxt = statusTxt + `${key} status: ${json[key].status}; `;
      }
    }
    statusTxt = statusTxt + '}';
    console.log(`${counter}. ${path} ${statusTxt} ${updateTimer()}`);
}

async function executeOperation(url, operation, apiMethod = 'POST') {
    const { hostname, pathname } = new URL(url);
    const [branch, repo, owner] = hostname.split('.')[0].split('--');
    const adminURL = `https://admin.hlx.page/${operation}/${owner}/${repo}/${branch}${pathname}`;

    // status op only supports GET
    const m = (operation === 'status') ? 'GET' : apiMethod;

    try {
        const resp = await fetch(adminURL, {
            method: m,
        });

        counter += 1;
        const text = await resp.text();

        if (resp.ok) {
            if (operation === 'index') {
                logIndexResponse(pathname, text);
            } else {
                logApiResponse(pathname, text);
            }
        } else {
            errorCount += 1;
            console.log(`${counter}. (Error: ${errorCount}) FAILED ${operation} ${apiMethod} ${url}: ${resp.status} ${text}`);
        }
    } catch (err) {
        errorCount += 1;
        console.log(`${counter}. (Error: ${errorCount}) FAILED ${operation} ${apiMethod} ${url}: ${err.message}`);
    }
}

function getOperation(argv) {
    const op = argv.operation.toLowerCase();
    if (VALID_OPERATIONS.includes(op)) {
        return op;
    }
    throw new Error(`${argv.operation} not a valid operation`);
}

function getMethod(argv) {
    const m = argv.method.toUpperCase();
    if (VALID_METHODS.includes(m)) {
        return m;
    }
    throw new Error(`${argv.method} not a valid method`);
}

const command = 'publish';
const desc = 'command to handle mass preview/publish/index operations in Franclin';

const builder = {
    target: {
        alias: 't',
        describe: 'folder id of the Google Drive folder to publish documents from',
        required: true
    },
    credentials: {
        alias: 'c',
        describe: 'OAuth Client ID credentials (download JSON from Google Developer Console)',
        required: true
    },
    hostname: {
        alias: 'h',
        describe: 'Franklin project specific hostname',
        required: true
    },
    operation: {
        alias: 'op',
        describe: `Franklin Admin API operation ${JSON.stringify(VALID_OPERATIONS)}`,
        default: `${VALID_OPERATIONS[0]}`
    },
    method: {
        alias: 'm',
        describe: `Franklin Admin API http method ${JSON.stringify(VALID_METHODS)}`,
        default: `${VALID_METHODS[0]}`
    },
    rootContext: {
        alias: 'r',
        describe: 'root url context to publish if other than target folder',
    },
    async: {
        description: "number of documents to publish asynchronously",
        type: "number",
        default: 10
    },
}

const processAsync = async (urls, options) => {
    await ConcurrencyUtil.processAll(urls, async (u, options, index, array) => {
        await executeOperation(u, options.op, options.method);
    }, options, options.async, 1000, true);
}

const handler = async (argv) => {
    const driveAPI = new DriveAPI();
    const drive = await driveAPI.init(argv.credentials);
    const folderId = argv.target;
    const op = getOperation(argv);
    const method = getMethod(argv);
    const host = `https://${argv.hostname}`;
    const async = argv.async;

    let context = argv.rootContext;
    if (!context) {
        let contextFolder = await drive.files.get({fileId: folderId});
        context = `/${contextFolder.data.name}`;
    }

    startTime = Date.now();
    const options = { op, method, async };
    let urls = [];
    await driveAPI.scanFiles(folderId, async (file, path) => {
        if (file.mimeType === 'application/vnd.google-apps.document') {
            urls.push(`${host}${path}`);
            if (urls.length >= 1000) {
                console.log(`Publishing ${urls.length}.`);
                await processAsync([...urls], options);
                urls = [];
            }
        }
    }, true, context);

    
    console.log(`Publishing ${urls.length}.`);
    await processAsync([...urls], options);
    console.log(`Finished "${op}" operation on ${counter} documents in ${updateTimer()}. Failed ${errorCount}.`);
}

export default {
    command,
    desc,
    builder,
    handler
}