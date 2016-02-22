'use strict';

var MarkdownIt = require('markdown-it'),
md = new MarkdownIt({
  'langPrefix': 'language-'
}),
fs = require('fs-extra'),
jquery = fs.readFileSync("./jquery-2.1.4.min.js", "utf-8"),
jsdom = require("jsdom"),
async = require('async'),
http = require('http'),
string = require('string'),
notification = require("./notification");

var BeanstalkdService = function(db, redis) {

  var emit = (post, callback) => {
    db.collection("objects").findOne({_key:'topic:' + post.tid}, (err, topic) => {
      if(err) {
        return callback(err)
      }
      if(post.pid == topic.mainPid) {
        var message = {status: post.status, tid: topic.tid};
        io.to('category_' + topic.cid).emit('kernel:topic', message);
        io.to('recent_topics').emit('kernel:topic', message);
        io.to('popular_topics').emit('kernel:topic', message);
        io.to('unread_topics').emit('kernel:topic', message);
      }
      return callback(null, null);
    });
  };

  var kernel = function (post, dir, url, username, password, callback) {
    async.waterfall([
      (callback) => {
        var html = md.render(post.content);
        jsdom.env({
          html: html,
          src: [jquery],
          done: callback
        });
      },
      (window, callback) => {
        var codes = window.$("code[class='language-mma']");
        if(codes.length < 1) {
          window.close();
          return callback('回复[post:'+post.pid+']内容找不到执行脚本');
        }
        var scripts = []
        for(var i = 0; i < codes.length; i++) {
          scripts.push(window.$(codes[i]).text())
        }
        window.close();
        return callback(null, scripts);
      },
      (scripts, callback) => {
        post.status = 2;
        emit(post, (err) => {
          return callback(err, scripts);
        })
      },
      (scripts, callback) => {
        db.collection("objects").updateOne({_key:'post:' + post.pid}, {$set: {status: post.status}}, (err) => {
          return callback(err, scripts);
        })
      },
      (scripts, callback) => {
        fs.mkdirsSync(dir + post.pid);
        var kernel = JSON.stringify({dir: dir + post.pid + '/', scripts:scripts});
        var options = {
          path: url,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Content-Length': Buffer.byteLength(kernel, 'utf8')
          },
          auth: username + ':' + password
        };
        var request = http.request(options, (response) => {
          return callback(null, response);
        });
        request.write(kernel);
        request.end();
      },
      (response, callback) => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          return callback(null, response.statusCode, chunk);
        });
      },
      (statusCode, chunk, callback) => {
        var pack = {set : {}, needRelease : false};
        if(statusCode == 200) {
          var act = JSON.parse(chunk);
          pack.set.status = 3;
          var lastData = act[act.length - 1];
          if(lastData.type == 'error') {
            pack.set.status = -1;
          } else if (lastData.type == 'abort') {
            pack.set.status = -2;
          }
          pack.set.result = act;
        } else if (statusCode == 500) {
          var act = JSON.parse(chunk);
          if(string(act.exception).contains('java.util.concurrent.TimeoutException')) {
            pack.set.status = -2;
          } else {
            pack.set.status = 1;
            pack.needRelease = true;
          }
        } else {
          pack.set.status = 1;
          pack.needRelease = true;
        }
        return callback(null, pack);
      },
      (pack, callback) => {
        post.status = pack.set.status;
        db.collection("objects").updateOne({_key:'post:' + post.pid}, {$set:pack.set}, (err) => {
          return callback(err, pack.needRelease);
        })
      },
      (needRelease, callback) => {
        emit(post, (err) => {
          return callback(err, needRelease);
        })
      },
      (needRelease, callback) => {
        notify.notice(post, (err) => {
          return callback(err, needRelease);
        });
      }
    ], (err, needRelease) => {
      if(err) {
        db.collection("objects").updateOne({_key:'post:' + post.pid}, {$set: {status: 1}}, (dbErr) => {
          return callback(err);
        })
      }
      return callback(null, needRelease);
    })
  };

  var db = db;

  var io = require('socket.io-emitter')(redis);

  var notify = new notification(db, io);

  this.update = function (jobData, callback) {
    var dir = jobData.dir,
    pid = jobData.pid,
    url = jobData.url,
    username = jobData.username,
    password = jobData.password;
    db.collection("objects").findOne({_key:'post:' + pid}, (err, post) => {
      if(err) {
        return callback(err);
      }
      if(!post) {
        return callback('回复[post:'+pid+']不存在');
      }
      if(post.status == 0) {
        fs.removeSync(dir + pid);
        return emit(post, (err) => {
          return callback(err, false);
        });
      } else if(post.status == 1) {
        fs.removeSync(dir + pid);
        return kernel(post, dir, url, username, password, callback);
      } else {
        return callback('回复[post:'+post.pid+']状态错误['+post.status+'], 期望值: 1或0');
      }
    });
  };

  this.purge = function (jobData, callback) {
    var dir = jobData.dir,
    pid = jobData.pid;
    fs.removeSync(dir + pid);
    return callback(null, false);
  };

  this.create = function (jobData, callback) {
    var dir = jobData.dir,
    pid = jobData.pid,
    url = jobData.url,
    username = jobData.username,
    password = jobData.password;
    db.collection("objects").findOne({_key:'post:' + pid}, (err, post) => {
      if(err) {
        return callback(err);
      }
      if(!post) {
        return callback('回复[post:'+pid+']不存在');
      }
      if(post.status != 1) {
        return callback('回复[post:'+post.pid+']状态错误['+post.status+'], 期望值: 1');
      }
      return kernel(post, dir, url, username, password, callback);
    });
  };

  this.clean = function(dir, second, callback) {
    var total = 0;
    var current = new Date();
    fs.walk(dir).on('data', (file) => {
      if(file.stats.isFile()) {
        var createTime = file.stats.birthtime.getTime();
        var span = ((current.getTime() - createTime) / 1000);
        if(span > second) {
          fs.removeSync(file.path);
          total++;
        }
      }
    })
    .on('end', () => {
      callback(null, total);
    })
  };

}

module.exports = BeanstalkdService;
