
var crypto = require("crypto");

module.exports = function(options) {
  options = options || {};
  return function(req, res, next) {
    res.autoEtag = function() {
        if (res._autoEtagSet) {
            return; // This should only be called once per request
        }

        var etag = res.get('Etag');
        var lastModified = res.get('Last-Modified');

        // If an etag has already been set, trust it
        var hash = (etag || lastModified) ? null : crypto.createHash('md5');

        var oldWrite = res.write;
        res.write = function(data) {
            // Whenever a write is called, update the hash with that data
            if (hash) {
                hash.update(data);
            }
            oldWrite.apply(res, arguments);
        };

        var oldEnd = res.end;
        var endCalled = false;
        res.end = function(data) {
            if (endCalled) { return oldEnd.apply(res, arguments); }
            else { endCalled = true; }
            if (data && hash) {
                hash.update(data);
                etag = hash.digest('hex');
                res.setHeader('Etag', etag);
            }

            res.header('Cache-Control', 'private, must-revalidate, max-age=0, post-check=0, pre-check=0');

            // First check for an etag match
            if (etag && req.header("if-none-match") == etag) {
                // If the etag matches, nothing has changed
                return res.send("Cached", 304);
            }
            // If applicable, check for a lastmodifed match
            if (lastModified) {
                //console.log("Using last modified", res.get('Last-Modified'));
                lastModified = new Date(lastModified);
                var ifModSince = new Date(req.get('if-modified-since'));
                if (req.get('if-modified-since') && lastModified <= ifModSince) {
                    return res.send('Cached', 304);
                }
            }

            // Fall back to outputing the real data
            return oldEnd.apply(res, arguments);
        };
        res._autoEtagSet = true;
    };
    res.setEtag = function(etag) {
        res.set('Etag', etag);
        res.autoEtag();
        if (etag && req.get("if-none-match") == etag) {
            return false;
        } else {
            return true;
        }
    };
    res.setLastModifiedDate = function(date) {
        res.set('Last-Modified', date.toString());
        res.autoEtag();
        var ifModSince = new Date(req.get('if-modified-since'));
        if (ifModSince && date <= ifModSince) {
            return false;   // If this returns false you can short-circuit your code and just do res.end();
        } else {
            return true;
        }
    };

    next();
  };
};

