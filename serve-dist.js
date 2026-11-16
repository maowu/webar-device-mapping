// Minimal static file server for smoke-testing the built dist/ over plain HTTP.
const http = require('http')
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, 'dist')
const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.glb':'model/gltf-binary','.wasm':'application/wasm','.mp3':'audio/mpeg','.tflite':'application/octet-stream','.fbx':'application/octet-stream','.bin':'application/octet-stream','.ttf':'font/ttf','.woff':'font/woff'}
http.createServer((req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p.endsWith('/')) p += 'index.html'
  let f = path.join(root, p)
  if (!f.startsWith(root)) { res.writeHead(403); return res.end('forbidden') }
  fs.readFile(f,(err,data)=>{
    if(err){ res.writeHead(404); return res.end('not found: '+p) }
    res.setHeader('Content-Type', types[path.extname(f)]||'application/octet-stream')
    res.setHeader('Access-Control-Allow-Origin','*')
    res.end(data)
  })
}).listen(8123, ()=>console.log('dist server on http://localhost:8123'))
