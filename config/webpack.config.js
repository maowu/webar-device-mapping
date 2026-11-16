/**
 * Multi-page webpack build, driven entirely by ../experiences.config.js.
 *
 * For each experience it produces:
 *   • an entry bundle   →  dist/<route>.bundle.js
 *   • a standalone page →  dist/<route>/index.html
 * plus the landing page at dist/index.html.
 *
 * `route` is '<category>s/<id>' (e.g. 'games/ar-treasure-hunt').
 * external/ (8th Wall engine + XRExtras) is copied verbatim.
 */
const path = require('path')
const fs = require('fs')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const manifest = require('../experiences.config.js')
const {experiences, routeOf} = manifest

// Minimal .env parser (no dotenv dependency): KEY=VALUE lines, '#' comments, blank lines ignored.
const loadEnvFile = (envPath) => {
  if (!fs.existsSync(envPath)) return {}
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  const env = {}
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

const dotenv = loadEnvFile(path.join(__dirname, '..', '.env'))
// Only whitelisted keys are exposed to client bundles — never dump all of process.env.
const clientEnv = {
  FIREBASE_DATABASE_URL: dotenv.FIREBASE_DATABASE_URL || process.env.FIREBASE_DATABASE_URL || '',
}

// Single-experience mode: when the manifest sets `landing: false` and there is
// exactly one experience, that experience is served at the site root (no
// landing page). Otherwise the landing page is the root. Default: landing on.
const hasLanding = manifest.landing !== false
const singleRoot = !hasLanding && experiences.length === 1

const rootPath = process.cwd()
const distPath = path.join(rootPath, 'dist')
const srcPath = path.join(rootPath, 'src')
const customOpenCvPath = path.join(rootPath, 'scripts', 'opencv-slim-build', 'opencv-slim-candidate.js')

// Attributes whose URLs html-loader should resolve through webpack (in scene.html).
const ATTRIBUTES_TO_EXPAND = ['src']

// ── Entries + HTML pages, generated from the manifest ────────────────────
const entry = {}
const htmlPlugins = []

if (hasLanding) {
  entry.landing = './landing/landing.js'
  htmlPlugins.push(
    new HtmlWebpackPlugin({
      template: path.join(srcPath, 'landing', 'index.html'),
      filename: 'index.html',
      inject: false,
    })
  )
}

for (const exp of experiences) {
  const route = routeOf(exp) // e.g. 'games/ar-treasure-hunt'
  entry[route] = `./${route}/main.js`
  htmlPlugins.push(
    new HtmlWebpackPlugin({
      template: path.join(srcPath, route, 'index.html'),
      // In single-experience mode the lone experience IS the site root.
      // Its bundle still emits at /<route>.bundle.js (which its index.html
      // already references), so only the page filename changes.
      filename: singleRoot ? 'index.html' : `${route}/index.html`,
      inject: false,
    })
  )
}

// ── Loaders ──────────────────────────────────────────────────────────────
const makeJsLoader = () => ({
  test: /\.jsx?$/,
  // The custom OpenCV artifact is generated Emscripten output containing an
  // embedded WASM payload. It must be bundled byte-for-byte, not transpiled by
  // Babel (which is both expensive and can corrupt generated glue code).
  exclude: [/node_modules/, customOpenCvPath],
  use: {
    loader: 'babel-loader',
    options: {
      presets: ['@babel/preset-env'],
      plugins: ['@babel/plugin-transform-runtime'],
    },
  },
})

const makeCssLoader = () => ({
  test: /\.css$/,
  use: ['style-loader', 'css-loader'],
})

const makeHtmlLoader = () => ({
  test: /\.html$/,
  use: {
    loader: 'html-loader',
    options: {
      esModule: false,
      sources: {
        list: [
          '...',
          // Never rewrite <script src> — the 8th Wall engine + page bundles
          // are referenced with root-absolute paths on purpose.
          {tag: 'script', attribute: 'src', type: 'src', filter: () => false},
          ...ATTRIBUTES_TO_EXPAND.map((attribute) => ({tag: '*', attribute, type: 'src'})),
        ],
      },
    },
  },
})

module.exports = {
  context: srcPath,
  entry,
  output: {
    filename: '[name].bundle.js',
    path: distPath,
    publicPath: '/',
    clean: true,
  },
  resolve: {
    extensions: ['.js', '.jsx'],
    fallback: {
      crypto: false,
      fs: false,
      path: false,
    },
  },
  module: {
    // OpenCV's UMD wrapper has no webpack dependencies. Skipping the parser
    // keeps production builds fast while webpack still emits it as the async
    // chunk requested by opencv-loader.js.
    noParse: (resource) => path.resolve(resource) === customOpenCvPath,
    rules: [makeJsLoader(), makeCssLoader(), makeHtmlLoader()],
  },
  plugins: [
    ...htmlPlugins,
    new CopyWebpackPlugin({
      patterns: [
        {from: path.join(rootPath, 'external'), to: path.join(distPath, 'external'), noErrorOnMissing: true},
      ],
    }),
    new webpack.DefinePlugin({
      'process.env.FIREBASE_DATABASE_URL': JSON.stringify(clientEnv.FIREBASE_DATABASE_URL),
    }),
  ],
  mode: 'production',
  devServer: {
    host: '0.0.0.0',
    server: 'https',
    allowedHosts: ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.io'],
    open: false,
    compress: true,
    hot: true,
    liveReload: false,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
    },
    client: {overlay: {warnings: false, errors: true}},
  },
}
