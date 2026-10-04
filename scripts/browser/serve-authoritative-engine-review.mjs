// Diagnostic host instance; never changes either host checkout or engine pin.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
const [hostArg,engineArg,portArg]=process.argv.slice(2);
if(!hostArg||!engineArg||!portArg)throw Error('Host cwd, authoritative engine and free port required');
const root=resolve(hostArg),engine=realpathSync(resolve(engineArg)),port=Number(portArg);
if(!Number.isInteger(port)||port<1024)throw Error('Invalid port');
process.chdir(root);
const {createServer,searchForWorkspaceRoot}=await import(pathToFileURL(resolve(root,'node_modules/vite/dist/node/index.js')).href);
const server=await createServer({root,configFile:resolve(root,'vite.config.ts'),cacheDir:resolve(root,'.vite-authoritative-review-cache'),server:{host:'127.0.0.1',port,strictPort:true,hmr:false,fs:{allow:[searchForWorkspaceRoot(root),root,engine]}}});
await server.listen();server.printUrls();
