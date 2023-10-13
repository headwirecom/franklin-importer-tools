import DriveAPI from '../impl/DriveAPI.js';

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
    rootContext: {
        alias: 'r',
        describe: 'root url context to publish if other than target folder',
    }
}

const handler = async (argv) => {
    const driveAPI = new DriveAPI();
    const drive = await driveAPI.init(argv.credentials);
    const folderId = argv.target;

    let context = argv.rootContext;
    if (!context) {
        let contextFolder = await drive.files.get({fileId: folderId});
        context = `/${contextFolder.data.name}`;
    }

    console.log(`publishing ${context}`);

    driveAPI.scanFiles(folderId, (file, path) => {
        if (file.mimeType === 'application/vnd.google-apps.document') {
            console.log(`publishing ${path}`);
        }
    }, true, context);
}

export default {
    command,
    desc,
    builder,
    handler
}