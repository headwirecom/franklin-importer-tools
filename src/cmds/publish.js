import DriveAPI from '../impl/DriveAPI.js';
import fetch from '@adobe/node-fetch-retry';

const VALID_OPERATIONS = [ 'preview', 'live', 'index', 'cache', 'status' ];
const VALID_METHODS = [ 'POST', 'GET', 'DELETE' ];

let counter = 0;

function logIndexResponse(path, text) {
    const json = JSON.parse(text);
    const indeces = json.results;
    let logTxt = `${counter}. ${path}`;
    indeces.forEach((index) => {
      if (index.record) {
        let indexRecord = JSON.stringify(index.record);
        logTxt = logTxt + ` Index name "${index.name}": ${indexRecord}`;
      }
    });
    console.log(logTxt);
}

function logApiResponse(path, text) {
    const json = JSON.parse(text);
    let statusTxt = '{ ';
    for (let key of Object.keys(json)) {
      if (json[key].status && key !== 'links') {
        statusTxt = statusTxt + `${key} status: ${json[key].status} `;
      }
    }
    statusTxt = statusTxt + '}';
    console.log(`${counter}. ${path} ${statusTxt}`);
}

async function executeOperation(url, operation, apiMethod = 'POST') {
    const { hostname, pathname } = new URL(url);
    const [branch, repo, owner] = hostname.split('.')[0].split('--');
    const adminURL = `https://admin.hlx.page/${operation}/${owner}/${repo}/${branch}${pathname}`;

    // status op only supports GET
    const m = (operation === 'status') ? 'GET' : apiMethod;
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
        console.log(`${counter}. FAILED ${operation} ${apiMethod} ${url}: ${resp.status} ${text}`);
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
    }
}

const handler = async (argv) => {
    const driveAPI = new DriveAPI();
    const drive = await driveAPI.init(argv.credentials);
    const folderId = argv.target;
    const op = getOperation(argv);
    const method = getMethod(argv);
    const host = `https://${argv.hostname}`;

    let context = argv.rootContext;
    if (!context) {
        let contextFolder = await drive.files.get({fileId: folderId});
        context = `/${contextFolder.data.name}`;
    }

    await driveAPI.scanFiles(folderId, async (file, path) => {
        if (file.mimeType === 'application/vnd.google-apps.document') {
            await executeOperation(`${host}${path}`, op, method);
        }
    }, true, context);
}

export default {
    command,
    desc,
    builder,
    handler
}