# franklin-importer-tools
Content migration tools for AEM Franklin

## Getting Started

Clone this project and run `npm install`.

### Supported Operations - Get Help 

Document import:
```
./index.js import --help
```

Google Drive upload:
```
./index.js upload --help
```

Publishing and Indexing (via Franklin Admin API)
```
./index.js publish --help
```   

## Import Usage and Examples

```
./index.js import --help
```

### To run an import
Simple example:
```
./index.js import --urls data/test-urls.json --ts scripts/import.mjs
```
Change `data/test-urls.json` to a path of the file containing JSON array of URLs to import. Change `scripts/import.js` to project specifc transformation script. 
See [Franklin Importer UI](https://github.com/adobe/helix-importer-ui) project and [Importer Guidelines](https://github.com/adobe/helix-importer-ui/blob/main/importer-guidelines.md)
for more information on transformation script.

By default imported documents and import report will be stored under `docs` subfolder. You can change this as follows.
```
./index.js import --urls data/test-urls.json --ts scripts/import.mjs --target /myImportedDocs
```

You can pass parameters to transformation script (params argument in your transformation script method).
```
./index.js import --urls data/test-urls.json --ts scripts/import.mjs --target /myImportedDocs --params data/params.json
```

Note that both ```--urls``` and ```--params``` except a valid JSON string as input insead of a file path or URL (JSON array for ```--urls```).
```
./index.js import --urls '["https://www.golfdigest.com/story/british-open-2023-sleepers"]' --ts scripts/import.mjs --target /myImportedDocs --params '{ "param1": "banana", "param2": "apple" }'
```

#### Notes on transformation script
Note that in order to be loaded by Node module system the transformation script file has a `.mjs` extension. 
Also, for compatibility with both this CLI tool and [Franklin Importer UI](https://github.com/adobe/helix-importer-ui) runing in the browser it needs to have both exports bellow.
```javascript
// export compatible with node
export {
  preprocess,
  transform
}

// export compatible with browser but breaks with node
export default {
  preprocess: preprocess,
  transform: transform
}
```

## Google Drive Authentication (credentials.json)

This applies to upload and publish commands which require access to files and folders on Google Drive. 

### Create credentials.json file 

1. Go to the [Google Developers Console](https://console.cloud.google.com).
2. Create a new project or select an existing one.
3. Enable the Google Drive API for your project.
4. Create credentials (OAuth 2.0 client ID) for your project.
5. Download the JSON credentials file, and save it as ```credentials.json``` in your local file system.

### Login

Use  ```--credentials``` or ```-c``` argument to pass  ```credentials.json``` location to ```upload``` or ```publish``` commands. The first time you run one of these commands the program will open a browser window with Google Authentication prompt. Login as Google user that has access to Google Drive folder where your Franklin project content will be stored. Authentication token will saved in ```token.json``` file and used authenticate next time you run one of these commands. Delete token.json if you need to refresh the token or login as different user. 

## Upload Usage and Examples

Google Drive upload:

```
./index.js upload --help
```

Upload to an empty folder on google drive:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json
```

Upload to a folder on google drive and overwrite files with the same name:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json -mode overwrite
```

Upload to a folder on google drive and overwrite files with the same name only if a local copy is newer:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json -mode overwriteOlder
```

Upload to a folder on google drive and overwrite files with the same name only if a local copy is newer:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json -mode overwriteOlder
```

Upload to a folder on google drive only if the file with the same name does not exist on google drive:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json -mode keepRemote
```

Estimate total number of files and total size of the upload:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json -mode scanonly
```

Estimate total number of files and total size of the upload, and print current file listing from Google Drive:
```
./index.js upload -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj -s ./myImportedDocs -c credentials.json -mode scanonly -p
```

## Publishing Usage and Examples

```
./index.js publish --help
``` 

Publish to preview
```
./index.js publish -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj --op preview -h main--helix-sportsmagazine--headwirecom.hlx
``` 

Publish live
```
./index.js publish -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj --op live -h main--helix-sportsmagazine--headwirecom.hlx
``` 

Index
```
./index.js publish -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj --op index -h main--helix-sportsmagazine--headwirecom.hlx
``` 

Get current index
```
./index.js publish -t 1HyaaV7_cFS4O0rHm2Zk2KChUOjjjj --op index -m GET -h main--helix-sportsmagazine--headwirecom.hlx
``` 