const fs = require('fs');
const path = require('path');
const { Registry } = require('@openovate/jsm');

const babel = require('@babel/core');
const requireFromString = require('require-from-string');

const React = require('react');
const { renderToString, renderToStaticMarkup } = require('react-dom/server');

const Helpers = require('./Helpers');
const WebpackPlugin = require('./WebpackPlugin');
const RequireResolver = require('./RequireResolver');
const VirtualRegistry = require('./VirtualRegistry');

class VirtualEngine extends VirtualRegistry {
  /**
   * @var {Object} files - { context target: actual code }
   */
  get files() {
    if (!this.lazyFiles) {
      const files = {};
      //load files from sources
      for(const target in this.sources) {
        const source = this.sources[target];
        //if it doesn't exist or is not a file
        if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
          //assume it's a string
          files[target] = source;
          continue;
        }

        files[target] = fs.readFileSync(source);
      }

      //manually make a routes.js file
      const routes = {};
      const views = this.get('views') || {};
      Object.keys(views).forEach(path => {
        routes[views[path].route] = path;
      });

      //generate routes file
      const label = this.get('label');
      const target = this.get('path', 'routes').replace('{LABEL}', label);
      files[target] = 'module.exports = ' + JSON.stringify(routes, null, 2);

      this.lazyFiles = files;
    }

    return this.lazyFiles;
  }

  /**
   * @var {Object} sources - { context target: source path }
   */
  get sources() {
    const sources = {};

    //get the label name
    const label = this.get('label');
    const template = this.get('path');

    //get entry
    const entry = template.entry.replace('{LABEL}', label);
    sources[entry] = this.get('source', 'entry');

    //get router
    const router = template.router.replace('{LABEL}', label);
    sources[router] = this.get('source', 'router');

    //get views
    const views = this.get('views') || {};
    Object.keys(views).forEach(path => {
      const target = template.view
        .replace('{LABEL}', label)
        .replace('{PATH}', path);
      sources[target] = views[path].view;
    });

    //get components
    const components = this.get('components') || {};
    Object.keys(components).forEach(name => {
      const target = template.component
        .replace('{LABEL}', label)
        .replace('{NAME}', name);
      sources[target] = components[name];
    });

    //deal with custom files
    // formatted like - { context target: source path }
    const custom = this.get('map');
    Object.keys(custom).forEach(target => {
      //name the source
      const source = custom[target];
      //if the source does not exist
      if (!fs.existsSync(source)) {
        //skip
        return;
      }

      //if source is a folder
      if (fs.statSync(source).isDirectory()) {
        //walk the folder and add files that it finds
        Helpers.walk(fs, source, file => {
          //so let's say source is /foo/bar/zoo
          //file could look like /foo/bar/zoo/bam.js
          //so we just need to chop off the source and use the target instead
          const sourceTarget = path.join(target, file.substr(source.length));
          sources[sourceTarget] = file;
        });

        return;
      }

      //source is a file
      sources[target] = custom[target];
    });

    return sources;
  }

  /**
   * @var {Plugin} WebpackPlugin
   */
  get WebpackPlugin() {
    //trick to bind an extra argument to constructor
    return VirtualEngine.WebpackPlugin.bind(null, this);
  }

  /**
   * Sets up the registry
   *
   * @param {Object} config
   */
  constructor(config = {}) {
    super(config);

    //add defaults to config
    Helpers.merge(this.data, {
      //used for white labeling
      label: 'reactus',
      //virtual path templates which represent the target destination
      path: {
        component: 'node_modules/{LABEL}/components/{NAME}.jsx',
        entry: 'node_modules/{LABEL}/entry.js',
        router: 'node_modules/{LABEL}/Router.jsx',
        routes: 'node_modules/{LABEL}/routes.js',
        view: 'node_modules/{LABEL}/views/{PATH}.jsx'
      },
      //fixed source paths
      source: {
        babel: path.resolve(__dirname, '../.babelrc'),
        entry: path.resolve(__dirname, 'client/entry.js'),
        router: path.resolve(__dirname, 'client/Router.jsx')
      }
    });

    this.lazyFiles = null;
    this.lazyPresets = null;

    this.resolver = VirtualEngine.RequireResolver.load()
      .on('resolve', this.resolveFile.bind(this));

    //if this is a name engine
    if (this.has('name')) {
      this.resolver.on('resolve', this.resolveEngine.bind(this));
    }
  }

  /**
   * Registers a global component
   *
   * @param {String} name
   * @param {String} path
   *
   * @return {VirtualEngine}
   */
  component(name, path) {
    super.component(name, path);
    //uncache files
    this.lazyFiles = null;
    return this;
  }

  /**
   * Require resolver for named engines
   *
   * @param {String} request
   * @param {FileResolve} resolve
   *
   * @return {(Array|False)}
   */
  resolveEngine(request, resolve) {
    //if it's already resolved
    if (resolve.isResolved()) {
      //don't resolve
      return;
    }

    //if the request starts with / or;
    if (request.indexOf('/') === 0
      //if the request starts with . or;
      || request.indexOf('.') === 0
      //if this is not a name engine
      || !this.has('name')
    ) {
      //cannot resolve
      return;
    }

    //get the label
    const name = this.get('name');
    const label = this.get('label');
    //looking for something like reactus/engine/web.js
    //if the request doesn't start with reactus/engine/web
    if (request.indexOf(path.join(label, 'engine', name)) !== 0) {
      //cannot resolve
      return;
    }

    //make the actual intended path
    resolve.set(
      //file
      path.join(__dirname, '../..', request),
      //exports
      this
    );
  }

  /**
   * Require resolver for registered files
   *
   * @param {String} request
   * @param {FileResolve} resolve
   */
  resolveFile(request, resolve) {
    //if it's already resolved
    if (resolve.isResolved()) {
      //don't resolve
      return;
    }

    //if the request starts with /, . or is not a file
    if (request.indexOf('/') === 0
      || request.indexOf('.') === 0
      || !this.files['node_modules/' + request]
    ) {
      //cannot resolve
      return;
    }

    //transform the code back to commonjs
    const content = this.files['node_modules/' + request].toString();
    const { code } = babel.transform(content, this.presets);

    const source = this.sources['node_modules/' + request];

    resolve.set(
      //file
      path.join(__dirname, '../..', request),
      //exports
      requireFromString(code, source)
    );
  }

  /**
   * Registers a view
   *
   * @param {String} route
   * @param {String} path
   * @param {String} view
   *
   * @return {Router}
   */
  view(route, path, view) {
    super.view(route, path, view);
    //uncache files
    this.lazyFiles = null;
    return this;
  }

  /**
   * Middleware for VirtualEngine.
   *
   * @param {(VirtualRegistry|Object|Function)} middleware
   *
   * @return {VirtualEngine}
   */
  use(middleware) {
    //if middleware is a VirtualRegistry
    if (middleware instanceof VirtualRegistry) {
      //just get the data
      middleware = middleware.data;
    }

    //if middleware is an object
    if (typeof middleware === 'object') {
      //merge and return
      Helpers.merge(this.data, middleware);
      //uncache files
      this.lazyFiles = null;
      return this;
    }

    //if middleware is a function
    if (typeof middleware === 'function') {
      //pass this engine to the middleware
      (async() => {
        //wait for the middleware
        await middleware(this) ;
        //uncache files
        this.lazyFiles = null;
      })();

      return this;
    }

    //anything else?

    return this;
  }
}

VirtualEngine.WebpackPlugin = WebpackPlugin;
VirtualEngine.RequireResolver = RequireResolver;
VirtualEngine.VirtualRegistry = VirtualRegistry;

module.exports = VirtualEngine;
