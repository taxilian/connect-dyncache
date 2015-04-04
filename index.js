var crypto = require("crypto");
var fs = require("fs");

module.exports = function(options) {
  // An options object.
  options = options || {};

  /*
    This object holds the watched files.
    A user may use `res.isChanged()` to see if a file was changed or not.

    Structure, using "foo.js" as an example:

    ```json
    {
      "foo.js": {
        "changed": < Timestamp when this object was last changed. >,
        "etag": < A hash of the file. >,
        "modified": < Date object of modification date. >,
        "expires": < Date object in the future, when this file should expire. Updated on change. >,
        "data": < Data you can inject for a file. >
      }
    }
    ```

    When checking for `res.isChanged()`, the file's `changed` timestamp
    should be compared to the current timestamp. If lower, we assume that
    the file has not changed.
  */
  __watchFiles = {};


  return function(req, res, next) {
    /**
      Creates an ETag based on the content you stream to your client.

      This function overwrites res.write and res.end in order to update a hash.
      Be aware though, you can not use this function to short-circuit your request,
      since it will simply run passively along the request.

      So if you are creating dynamic content and have some idea of how it could
      be hashed, I would totally recommend to use `res.setEtag()`, since you can
      see if you should or should not generate your content.
    */
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

            // I dont know why this is here. It should only be used on actual 304 responses.
            //res.header('Cache-Control', 'private, must-revalidate, max-age=0, post-check=0, pre-check=0');

            // First check for an etag match
            if (etag && req.header("if-none-match") == etag) {
                // If the etag matches, nothing has changed
                res.header('Cache-Control', 'private, must-revalidate, max-age=0, post-check=0, pre-check=0');
                return res.status(304).send("Cached");
            }
            // If applicable, check for a lastmodifed match
            if (lastModified) {
                lastModified = new Date(lastModified);
                var ifModSince = new Date(req.get('if-modified-since'));
                if (req.get('if-modified-since') && lastModified <= ifModSince) {
                  res.header('Cache-Control', 'private, must-revalidate, max-age=0, post-check=0, pre-check=0');
                  return res.status(304).send("Cached");
                }
            }

            // Fall back to outputing the real data
            return oldEnd.apply(res, arguments);
        };
        res._autoEtagSet = true;
    };

    /**
      Set a custom ETag and, if one is sent in request, validates it.

      @returns True, if the sent ETag matches the given. False if not.
      @hint The true and false statement used to be swapped!
            I edited it, because that makes more sense.
            It's now useful to fast-validate an Etag, too!
            `if(setEtag(...)) "Your ETag matches" else "Your ETag does not match"`
    */
    res.setEtag = function(etag) {
        res.set('Etag', etag);
        res.autoEtag();
        if (etag && req.get("if-none-match") == etag) {
            return true;
        } else {
            return false;
        }
    };

    /**
      Set the date, at which an object was last modified.
      Also checks if the given date is newer than the sent one.

      @returns True if the object has not changed since last time. False in the other case.
      @hint While I swapped the true and false above, it makes more sense here, as in:
            `if(LastModified(...)) "Your file was modified." else "It has not changed"`
            Get what I mean?
    */
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

    /**
      This function tells the client when this object expires exactly.
      Some browsers seem to favour this or that...so you can, if you want, add it.

      Call this function with no arguments to generate one, depending on the maxAge.

      @returns Nothing. There is no check that could be made or alike, since
               the `Expires:` header is only sent client-side.
               We _could_ look at `If-modified-since`, but this does not make
               any sense in this function. `res.setLastModifiedDate()` makes more
               sense for this case.
      @hint It seems that some versions of Chrome will send validation requests
            for a given ETag, but not if it was given the `Expires:` header.
    */
    res.setExpires = function(date) {
      date = new Date(date) || new Date( (new Date()).getTime()+res._dynMaxAge );
      res.setHeader("Expires", date.toUTCString());
    };

    /**
      This function sets the default max-age; the time to add to the current to
      define, when an object's lifetime is up.

      @param[in] age : Age, in milliseconds.
    */
    res._dynMaxAge = 0;
    res.setMaxAge = function(age) {
      this._dynMaxAge = age;
    }

    /**
      This function sets the `Cache-control` header field.

      @param[in] age: The age, in milliseconds. Used for `max-age=N{us}`
      @param[in] keywords: Want other things in this string? Add them through this array.
                 They will be prepended before `max-age` using commas (",").
                 If empty, it defaults to: ["public"].
      @returns Nothing.
      @hint Call this function _without arguments_ to use the previously set maxAge.
    */
    res.setCacheControl = function(age, keywords) {
      keywords = keywords || ["public"];
      age = age || res._dynMaxAge;
      keywords.push( "max-age="+age );
      var str = keywords.join(", ");
      res.setHeader("Cache-control", str);
    }


    /**
      This function defines a file to be watched.
      IMPORTANT: The file-object itself will only update, when the file
      has expired! This is useful for long-running conversions.

      @param[in] file: Full path to file - not an URL!
      @returns False on error, an object with the collected data and fs.stats
               on success.
    */
    res.watchFile = function(file) {
      if(fs.existsSync(file)) {
        console.log("-- Adding "+file+" ...");
        var obj = {};
        obj.changed = (new Date()).getTime();
        var stats = fs.lstatSync(file);
        obj.modified = stats.mtime.getTime();
        obj.expires = stats.mtime.getTime()+res._dynMaxAge;

        // Create an ETag...
        var etag = crypto.createHash("md5");
        etag.update(JSON.stringify(stats));
        obj.etag = etag.digest('hex');

        // Add!
        __watchFiles[file]=obj;

        // We can be nice for once. Maybe the user wants this?
        return {obj:obj, stats:stats};
      } else {
        // The file was not found, so we do NOT break the request...
        return false;
      }
    }

    /**
      Small method to test if a file is being watched.

      @param[in] file : File to test for
      @returns True on success
    */
    res.isWatching = function(file) {
      return (file in __watchFiles);
    }

    /**
      Unwatch a file. Useful if you manually want to re-save its infos.

      @param[in] file : The file.
      @returns Nothing.
    */
    res.unwatchFile = function(file) {
      if(file in __watchFiles)
        delete __watchFiles[file];
    }

    /**
      Look up if the file exists in the watched files object, and determine
      if it has changed or not - or even reload its stats and re-cache it.
      Use the second parameter to force a re-cache.

      @param[in] file : The file to check
      @param[in] force : Force a re-cache
    */
    res.isChanged = function(file, force) {
      force = force || false;
      if(res.isWatching(file)) {
        // Let's see... The file is indeed watched, so check it.
        var obj = __watchFiles[file];
        var now = (new Date()).getTime();
        // Expirency check
        if(force==true || now > obj.expires) {
          // The file has expired! Re-add the file.
          delete __watchFiles[file];
          res.watchFile(file);
          // Re-run
          return res.isChanged(file);
        }

        var isEtagged = res.setEtag(obj.etag);
        var isModified = res.setLastModifiedDate(new Date(obj.modified));
        console.log("-- Statistics:", { isEtagged:isEtagged, isModified:isModified });
        if(isModified==false && isEtagged) {
          // We are not modified and our etag matches: The file is unchanged.
          return false;
        } else {
          // If one of them does not match, the file is likely modified.
          return true;
        }
      } else {
        // A not-watched file is assumed to always change.
        return true;
      }
    }

    next();
  };
};
