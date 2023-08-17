# franklin-importer-tools
Content migration tools for AEM Franklin

## Basic Usage

Clone this project and run `npm install`.

### To run an import
Simple example:
```javascript
./index.js import --urls data/test-urls.json --ts scripts/import.mjs
```
Change `data/test-urls.json` to a path of the file containing JSON array of URLs to import. Change `scripts/import.js` to project specifc transformation script. 
See [Franklin Importer UI](https://github.com/adobe/helix-importer-ui) project and [Importer Guidelines](https://github.com/adobe/helix-importer-ui/blob/main/importer-guidelines.md)
for more information on transformation script.

By default imported documents and import report will be stored under `docs` subfolder. You can change this as follows.
```javascript
./index.js import --urls data/test-urls.json --ts scripts/import.mjs --target /myImportedDocs
```

You can pass parameters to transformation script (params argument in transformation script methods).
```javascript
./index.js import --urls data/test-urls.json --ts scripts/import.mjs --target /myImportedDocs --params data/params.json
```

Note that both ```--urls``` and ```--params``` except a valid JSON string as input insead of a file path or URL (JSON array for ```--urls```).
```javascript
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
