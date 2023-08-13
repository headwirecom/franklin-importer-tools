# franklin-importer-tools
Content migration tools for AEM Franklin

## Basic Usage

Clone this project and run `npm install`.

#### To run an import
Simple example:
```
./index.js import --urls data/test-urls.json --ts scripts/import.js
```
Change `data/test-urls.json` to a path of the file containing JSON array of URLs to import. Change `scripts/import.js` to project specifc transformation script. 
See [Franklin Importer](https://github.com/adobe/helix-importer-ui) project and [Importer Guidelines](https://github.com/adobe/helix-importer-ui/blob/main/importer-guidelines.md)
for more information on transformation script.

By default imported documents and import report will be stored under `docs` subfolder. You can change this as follows.
```
./index.js import --urls data/test-urls.json --ts scripts/import.js --target /myImportedDocs
``` 
