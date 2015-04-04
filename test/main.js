var app = require("express")();
var dyncache = require("../");
var fs = require("fs");

// Add it
app.use(dyncache());

// Pseudo-middleware factory.
function tester(inject) {
  return function(req,res,next){
    res.setHeader("Content-type", "text/plain");
    fs.readFile("./text.txt", function(err, ch){
      if(err) {
        return res.end("Error: "+JSON.stringify(err));
      }
      inject(req, res) && res.end(ch);
    });
  }
}

app.get("/etag", tester(function(req,res){
  res.autoEtag();
  return true;
}));

app.get("/etag2", tester(function(req,res){
  res.setEtag("hello_world");
  return true;
}));

app.get("/lm", tester(function(req,res){
  try {
    var st = fs.statSync("./text.txt");
    res.setLastModifiedDate(new Date(st.mtime));
    return true;
  } catch(e) {
    res.end("Exception: "+JSON.stringify(e));
    return false;
  }
}));

app.get("/maxage", tester(function(req,res){
  res.setCacheControl(1000*60*60*24);
  res.expires
  return true;
}));

// All of this at once.
var now = (new Date()).getTime();
var age = 1000*60; // max-age
app.get("/all", tester(function(req,res){
  // Generate random content.
  var content = "ABC";
  // A hash?
  var hash = "this_is_totally_random";
  // And, a date.
  var expires = new Date(now+age);

  // Inject...
  res.setEtag(hash);
  res.setLastModifiedDate(new Date(now));
  res.setExpires(expires);
  res.setCacheControl(age);

  return true;
}));

// Awesome for compile-file stuff. Like image optimizers and alike...
app.get("/changed", tester(function(req,res){
  var file = "./text.txt";
  res.setMaxAge(1000*60*60);
  if(!res.isWatching(file)) {
    res.watchFile(file);
  }
  if(res.isChanged(file)) {
    console.log("-- "+file+" has changed.");
  } else {
    console.log("-- "+file+" has not changed.");
    res.status(304).send("Cached");
    return false;
  }
  return true;
}));

app.listen(9999, function(){
  console.log("-- Listening on: localhost:9999");
});
