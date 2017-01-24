define([
         'coreJS/adapt',
         'extensions/adapt-trackingHub/js/adapt-trackingHub',
         './xapiwrapper.min',
         './xapiMessageComposer'
], function(Adapt, trackingHub, xapiwrapper, msgComposer) {

  var XapiChannelHandler = _.extend({

    _CHID: 'xapiChannelHandler',
    _STATE_ID: 'ACTIVITY_STATE',
    _OWNSTATEKEY: 'xapi',
    _OWNSTATE: null,
    _ACTOR: null,
    _CTXT_ACTIVITIES: null, // necessary for adl-xapi-launch

    _wrappers: {}, 

    initialize: function() {
      console.log('Initializing xapiChannelHandler');
      this.listenToOnce(Adapt.trackingHub, 'stateReady', this.onStateReady);
      trackingHub.addChannelHandler(this);
    },

    /*******************************************
    /*******      CONFIG  FUNCTIONS      *******
    /*******************************************/

    checkConfig: function() {
      this._config = Adapt.config.has('_tkhub-xAPI')
        ? Adapt.config.get('_tkhub-xAPI')
        : false;
      if (!this._config )  
        return false;

      this._config._channels = this._config._channels || [];
      if (! _.isArray(this._config._channels)) {
        console.log('The _channels setting must be an array.');
        return false;
      }
      var allChCorrect = true;
      _.each(this._config._channels, function(channel) {
          allChCorrect = allChCorrect && trackingHub.checkCommonChannelConfig(channel);
          allChCorrect = allChCorrect && this.checkSpecificConfig(channel);
      }, this);
      return allChCorrect;
    },

    checkSpecificConfig: function(channel) {
      // For any undefined values, set a default. Check that all the settings have the correct types.
      if (channel._endPoint == undefined)
        channel._endPoint = '';
      if (channel._xapiLaunchMethod == undefined)
        channel._xapiLaunchMethod =  'hardcoded';
      if (channel._isFakeLRS == undefined)
        channel._isFakeLRS = false;
      if (channel._homePage == undefined)
        channel._homePage = 'http://www.mylms.com';
      if (channel._mbox == undefined)
        channel._mbox = 'mailto:johndoe@example.com';
      if (channel._fullName == undefined)
        channel._fullName = 'John Doe';
      if (channel._userName == undefined)
        channel._userName = '';
      if (channel._password == undefined)
        channel._password = '';

      if ( _.isString(channel._xapiLaunchMethod) &&
         ( _.isBoolean(channel._isFakeLRS)) &&
         ( _.isString(channel._homePage)) &&
         ( _.isString(channel._mbox)) &&
         ( _.isString(channel._fullName)) &&
         ( _.isString(channel._userName)) &&
         ( _.isString(channel._password))) {
         return true;
      }
      console.log('There are errors in the specific channel settings for channel ' + channel._name + '.');
      return false;
    },

    getChannelDefinitions: function() {
      return this._config._channels;
    },

    applyChannelConfig: function(channel) {
        // the actor identity is set from the channel that is the launchManager
        // but the rest of the xapi parameters are initialized form the channel config
        // that way, we can track to more than one LRS (but only one must be the launchManager)
        console.log('xapiChannelHandler applying config to channel ' + channel._name);
        var conf = {};
        _.extend(conf, {"endpoint": channel._endPoint} );
        _.extend(conf, {"auth": "Basic "
            + toBase64(channel._userName + ":"
                     + channel._password) });
        this._wrappers[channel._name] = new XAPIWrapper(conf, false);
    },


    /*******  END CONFIG FUNCTIONS *******/



    /*******************************************
    /*******  LAUNCH SEQUENCE  FUNCTIONS *******
    /*******************************************/

    startLaunchSequence: function(channel, courseID) {
      // Use introspection. Just call the appropriate function if it exists.
      var launchFName = 'launch_' + channel._xapiLaunchMethod.toLowerCase();
      if (this.hasOwnProperty(launchFName)) {
          this[launchFName](channel, courseID);
      } else {
          alert('Unknown launch method (' + channel._xapiLaunchMethod + ') specified in config for channel ' + channel._name + 
                '. Please fix it. Tracking will not work on this channel.');
      }
      this.trigger('launchSequenceFinished');
    },

    launch_spoor: function(channel, courseID) {
        // the LRS data is read from the config file (it is basically harcoded into the content)
        // and the user id is retrieved through the LMS (the SCORM API)
        var studentID = pipwerks.SCORM.data.get("cmi.core.student_id"); // hard assumption on SCORM 1.2
        // I'd rather use Spoor's ScormWrapper.getStudentId() ... but I don't know how/if Spoor exposes part of its internal functionality
        var accountObj = { homePage: channel._homePage,
                           name: studentID
        }
        Adapt.trackingHub.userInfo.account =  accountObj;
        this._ACTOR = new ADL.XAPIStatement.Agent(accountObj);
    },

    launch_rustici: function(channel, courseID) {
        console.log('xapiChannelHandler ' + channel._name + ': starting rustici launch sequence...');
        // The format of the launch query string is:
        //<AP URL>/?endpoint=<lrsendpoint>&auth=<token>&actor=<learner>[&registration=<registration>][&activity_id=<activity ID>
        //[&activity_platform=<platform>][&Accept-Language=<acceptlanguage>][&grouping=<grouping activity ID>]
        var qs = trackingHub.queryString();
        var actor = JSON.parse(qs.actor);
        Adapt.trackingHub.userInfo.mbox =  actor.mbox;
        Adapt.trackingHub.userInfo.fullName =  actor.name;
        this._ACTOR = new ADL.XAPIStatement.Agent(actor.mbox, actor.name);
        this._LANG = qs['Accept-Language'];
        if (qs.activity_id) {
          // override the activity id if one was passed in the query string.
          trackingHub._config._courseID = qs.activity_id;          }
        this._REGISTRATION = qs.registration;
        var conf = { actor: this._ACTOR };
        conf.withCredentials = true;
        var wrapper = new ADL.XAPIWrapper.constructor();
        wrapper.changeConfig(conf); //this applies the conf, It will read the parameters from the query string
        this._wrappers[channel._name] = wrapper;
        console.log('xapiChannelHandler ' + channel._name + ': rustici launch sequence finished.');
    },

    launch_adlxapi: function(channel, courseID) {
        console.log('xapiChannelHandler ' + channel._name + ': starting launch sequence...');
        // adl xapi launch functionality is provided by the xAPIwrapper, so we just do as 
        // explained in https://github.com/adlnet/xAPIWrapper#xapi-launch-support
        var wrapper = null;
        var xch = this; // save reference to 'this', because I need it in the ADL.launch callback
        ADL.launch(function(err, launchdata, xAPIWrapper) {
          if (!err) {
            wrapper = xAPIWrapper;
            console.log("--- content launched via xAPI Launch ---\n", wrapper.lrs, "\n", launchdata);
            xch._ACTOR = launchdata.actor;
            xch._CTXT_ACTIVITIES = launchdata.contextActivities;
            xch._wrappers[channel._name] = xAPIWrapper;
          } else {
            alert('ERROR: could not get xAPI data from xAPI-launch server!. Tracking on this channel will NOT work!');
          }
        }, true);
    },

    launch_hardcoded: function(channel, courseID) {
        console.log('xapiChannelHandler ' + channel._name + ': starting hardcoded launch sequence...');
        Adapt.trackingHub.userInfo.mbox =  channel._mbox;
        Adapt.trackingHub.userInfo.fullName =  channel._fullName;
        this._ACTOR = new ADL.XAPIStatement.Agent(Adapt.trackingHub.userInfo.mbox, Adapt.trackingHub.userInfo.fullName);
        console.log('xapiChannelHandler ' + channel._name + ': hardcoded launch sequence finished.');
    },

    /*******  END LAUNCH SEQUENCE FUNCTIONS *******/


    processEvent: function(channel, eventSourceName, eventName, args) {
      // In this xapi channel handler we are just going to compose & deliver the message corresponding to this event
      // msgComposer is a reference to the message composer that this particular channel handler uses.
      message = msgComposer.compose(eventSourceName, eventName, args)
      if (message) {
          // in this case, the message is an INCOMPLETE xAPI statement, it's missing the Actor.
          // We add it here
          message.actor = this._ACTOR;
          this.deliverMsg(message, channel);
      }

      // call specific event handling function for the event being processed, if it exists 
      // funcName = Adapt.trackingHub.getValidFunctionName(eventSourceName, eventName);
      // console.log('funcName = ' + funcName);
      // We only need to write event handling functions for the events that we care about
      // In this particular channel handler we don't need to do any specific processing for particular events.
      // if (this.hasOwnProperty(funcName)) {
      //   this[funcName](args);
      // }
      // the fact that there's no method to handle a specific event is NOT an error, it's simply that this ChanneHandler doesn't care  about that event.

      // If there's any common processing that we need to do, no matter what event happened, do it here.
    },

    deliverMsg: function(message, channel) {
       // USE THE WRAPPER of this channel to send the statement to the LRS
       if (!channel._isFakeLRS) {
         var wrapper = this._wrappers[channel._name];
         wrapper.sendStatement(message, function() {});
         //console.log('xapiChannelHandler: sent statement ', message.text, message);
         console.log('xapiChannelHandler ' + channel._name + ': sent statement', message);
       } else {
           console.log('xapiChannelHandler ' + channel._name + ': FAKE POST of statement:', message);
       }
    },


    /*******************************************
    /*******  STATE MANAGEMENT FUNCTIONS *******
    /*******************************************/

    // this xAPIChannelHandler only implements load/save state.
    // It does NOT keep its own particular representation of state.

    saveState: function(state, channel, courseID) {
      // If we want a channelHandler to be  capable of saving state, we have to implement this function.
      // IMPORTANT: this function is always called from trackingHub NOT from within this channel handler!
      // Call the xapiwrapper to save state.
      var wrapper = this._wrappers[channel._name];
      wrapper.sendState(courseID, this._ACTOR, this._STATE_ID, null, state);
      console.log('xapiChannelHandler: state saved');
    },

    loadState: function(channel, courseID) {
      var state;
      var wrapper = this._wrappers[channel._name];
      var fullState = wrapper.getState(courseID, this._ACTOR, this._STATE_ID);
      if (!fullState || _.isArray(fullState)) {
          fullState = {};
      }
      console.log('xapiChannelHandler: state loaded');
      this.trigger('stateLoaded', fullState);
    },


    /*******  END STATE MANAGEMENT FUNCTIONS ********/



    /*******************************************
    /*** SPECIFIC EVENT PROCESSING FUNCTIONS ***
    /*******************************************/

    // no need to do any specific event processing in this channel handler.

    /*******  END SPECIFIC EVENT PROCESSING FUNCTIONS ********/


  }, Backbone.Events);

  XapiChannelHandler.initialize();
  return (XapiChannelHandler);
});
