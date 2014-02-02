var gulp = require('gulp')
  , VarStream = require('varstream')
  , Fs = require('fs')
  , Path = require('path')
  , Nunjucks = require('nunjucks')
  , express = require('express')
  , tinylr = require('tiny-lr')
  , rimraf = require('rimraf')
;

require('matchdep').filterDev('gulp-*').forEach(function(module) {
  global[module.replace(/^gulp-/, 'g-').replace(/-([a-z])/g, function(x,xx) {
    return xx.toUpperCase();
  })] = require(module);
});

// Loading global options (files paths)
var conf = VarStream.parse(Fs.readFileSync(__dirname+'/config.dat'))
  , server
  , prod = gulp.env.prod
  , buffer = !gulp.env.stream;

if(!prod) {
  // Finding the server IP
  conf.ip = '127.0.0.1';

  if(gulp.env.net) {
    var ints = require('os').getNetworkInterfaces();

    for(var int in ints) {
      if(ints[int].some(function(net) {
        if((!net.internal) && 'IPv4' == net.family) {
          conf.ip = net.address;
          return true;
        }
      })) {
        break;
      }
    }
  }
  conf.baseURL = 'http://'+conf.ip+':8080';
}


// Fonts
gulp.task('build_fonts', function(cb) {
  gulp.src(conf.src.icons + '/**/*.svg', {buffer: buffer})
    .pipe(gIconfont({
      'fontName': 'iconsfont',
      'appendCodepoints': true
    }))
    .pipe(gulp.dest(conf.build.fonts))
    .once('end', cb);
});

// Images
gulp.task('build_images', function(cb) {
  var n = 0;
  function end() { ++n==2 && cb(); }
  gulp.src(conf.src.images + '/**/*.svg', {buffer: buffer})
    .pipe(gIf(!prod, gWatch()))
    .pipe(gIf(prod, gSvgmin()))
    .pipe(gIf(!prod, gLivereload(server)))
    .pipe(gulp.dest(conf.build.images))
    .once('end', end);

  gulp.src(conf.src.images + '/**/*.{png,jpg,jpeg,gif}', {buffer: buffer})
    .pipe(gIf(!prod, gWatch()))
    .pipe(gIf(prod, gStreamify(gImagemin())))
    .pipe(gIf(!prod, gLivereload(server)))
    .pipe(gulp.dest(conf.build.images))
    .once('end', end);
});

// CSS
gulp.task('build_styles', function(cb) {
  gulp.src(conf.src.less + '/main.less', {buffer: buffer})
    .pipe(gStreamify((gLess())))
    .pipe(gIf(prod, gMinifyCss()))
    .pipe(gIf(!prod, gLivereload(server)))
    .pipe(gulp.dest(conf.build.css))
    .once('end', cb);
});

// JavaScript
gulp.task('build_js', function(cb) {
  var n = 0;
  function end() { ++n==3 && cb(); }
  gulp.src(conf.src.js + '/**/*.js', {buffer: buffer})
    .pipe(gStreamify(gJshint()))
    .once('end', end);

  gulp.src(conf.src.js + '/frontend.js', {buffer: buffer})
    .once('end', end) // gBrowserify never triggers 'end' ...
    .pipe(gBrowserify())
    .pipe(gIf(prod, gUglify()))
    .pipe(gConcat('script.js'))
    .pipe(gIf(!prod, gLivereload(server)))
    .pipe(gulp.dest(conf.build.frontjs));

  gulp.src(conf.src.js + '/frontend/vendors/**/*.js')
    .pipe(gulp.dest(conf.build.frontjs + '/vendors'))
    .once('end', end);
});

// HTML
gulp.task('build_html', function(cb) {
  var nunjucks = Nunjucks
    , tree = {}
    , markedFiles = []
    , dest = gulp.dest(conf.build.root)
  ;
  
  nunjucks.configure(conf.src.templates, {
    autoescape: true
  });

  gulp.src(conf.src.content + '/**/*.md', {buffer: buffer||true}) // Streams not supported
    .pipe(gMdvars())
    .pipe(gVartree({
      root: tree,
      index: 'index',
      parentProp: 'parent',
      childsProp: 'childs'
    }))
    .pipe(gMarked())
    .pipe(gRename({ext: '.html'}))
    .once('end', function() {
      markedFiles.forEach(function(file) {
        var nunjucksOptions = {
          env: conf.build.root,
          prod: prod,
          tree: tree,
          conf: conf,
          metadata: file.metas,
          content: file.contents.toString('utf-8')
        };
        // Render the template
        file.contents = Buffer(nunjucks.render(
          (nunjucksOptions.metadata.template || 'index') + '.tpl',
          nunjucksOptions
        ));
        // Save it.
        dest.write(file);
      });
      dest.end();
      cb();
    })
    .on('data', function(file) {
      markedFiles.push(file);
    }).resume();
});

// The clean task
gulp.task('clean', function(cb) {
  rimraf(conf.build.root, cb);
});

// The build task'clean', 
gulp.task('build', ['build_fonts', 'build_images', 'build_styles',
  'build_js', 'build_html'], function(cb) {
  if(!prod) {

    gulp.watch([
      conf.src.js + '/frontend/**/*.js',
      conf.src.js + '/frontend.js'
    ], function(event) {
      gulp.run('build_js');
    });

    gulp.watch([conf.src.less + '/**/*.less'], function(event) {
      gulp.run('build_styles');
    });

    gulp.watch([
      conf.src.content + '/**/*.md',
      conf.src.templates + '/**/*.tpl'
    ], function(event) {
      gulp.run('build_html');
    });

  }
  cb();
});

// Publish task
gulp.task('ghpages', ['build'], function(cb) {
  var exec = require('child_process').exec
    , execOptions = {
      cwd: __dirname
    };
  // Switch to ghpages branch
  exec('git branch -D gh-pages; git checkout -b gh-pages', execOptions, function() {
    // delete all files except the untracked ones
    var ignore = ['.git', 'www', 'node_modules'];
    Fs.readdirSync(__dirname).forEach(function(file) {
      if(-1 === ignore.indexOf(file)) {
        rimraf.sync(__dirname+'/'+file);
      }
    });
    Fs.readdirSync(__dirname+'/www').forEach(function(file) {
      Fs.renameSync(__dirname+'/www/'+file, __dirname+'/'+file);
    });
    Fs.rmdirSync(__dirname+'/www');
    // Add the domain name
    Fs.writeFileSync(__dirname + '/CNAME', conf.domain);
    // Add a new ignore file
    ignore.push('.gitignore');
    Fs.writeFileSync(__dirname + '/.gitignore', ignore.join('\n'));
    // Commit files
    exec('git add . && git commit -m "Build '+(new Date())+'"', execOptions, function() {
      
      // Pushing commit
      exec('git push -f origin gh-pages &&  git checkout master', execOptions, function() {
        cb();
      });
    });
  });
});

// Publish task
gulp.task('publish', function() {
  prod = true;
  gulp.run('ghpages');
});

// The default task
gulp.task('default', function() {
  // Starting the dev static server
  var app = express();
  app.use(express.query())
    .use(express.bodyParser())
    .use(express.static(Path.resolve(__dirname, conf.build.root)))
    .listen(8080, function() {
      console.log('Listening on %d', 35729);
      require('open')(conf.baseURL+'/index.html');
      gulp.watch([conf.src.icons + '/**/*.svg'], function(event) {
        gulp.run('build_fonts');
      });
      gulp.run('build');
    });
  server = tinylr();
  server.listen(35729);
});