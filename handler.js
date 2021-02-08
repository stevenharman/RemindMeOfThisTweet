'use strict';
const Sentry = require("@sentry/serverless");

Sentry.AWSLambda.init({
    dsn: process.env.SENTRY_DSN,
});

const cache = require('./src/cache');
const twitter = require('./src/factory.twitter')(cache);
const auth = require('./src/factory.auth')(cache);
const notifications = require('./src/notifications');
const service = require('./src/factory.service')(cache, twitter, notifications);
const {setUserSettings, getUserSettings} = require('./src/factory.settings')(cache);
const {http, getDateToNearestMinute, timezones} = require('./src/utils');
const twitterSignIn = require('twittersignin')({
    consumerKey: process.env.TWITTER_CONSUMER_KEY,
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

module.exports.handleAccountActivity = async (event, context) => {
    const body = JSON.parse(event.body);
    console.log(body);

    if (!body.tweet_create_events) {
        return http.success(`No new tweets`);
    }

    const screenName = process.env.TWITTER_SCREEN_NAME;
    const allMentions = body.tweet_create_events.filter(tweet => {
        // ignore retweets, but accept quotes
        if (tweet.retweeted_status && !tweet.is_quote_status) {
            return false;
        }

        // exclude manual retweets
        if (tweet.text.startsWith(`RT @${screenName}:`)) {
            return false;
        }

        // ignore tweets by myself
        if (tweet.user.screen_name === screenName) {
            return false;
        }

        return true;

    }).map(tweetObject => {
        return {
            id: tweetObject.id_str,
            created_at: tweetObject.created_at,
            text: tweetObject.full_text || tweetObject.text,
            referencing_tweet: tweetObject.in_reply_to_status_id_str,
            author: tweetObject.user.screen_name,
        };
    });

    try {

        if (allMentions.length) {
            // for failure/recovery purposes
            await cache.setAsync('lastTweetRetrieved', allMentions[allMentions.length - 1].id);
            let results = await Promise.all(allMentions.map(service.handleMention));
            await Promise.all(results.map(service.handleParsingResult));
        }
    } catch (err) {
        if (err instanceof (require("redis")).ReplyError) {
            console.log(`Redis error: ${err.command} ${err.args} ${err}`);
        }
        throw err;
    }

    return http.success(`Handled ${allMentions.length} tweets`);
};

(process.env.NODE_ENV === 'production') && (exports.handleAccountActivity = Sentry.AWSLambda.wrapHandler(exports.handleAccountActivity, {
    timeoutWarningLimit: 5000,
}));


module.exports.handleTwitterCrc = async (event, context) => {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', process.env.TWITTER_CONSUMER_SECRET)
        .update(event.queryStringParameters.crc_token).digest('base64');
    const response = {
        statusCode: 200,
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({response_token: 'sha256=' + hmac})
    };
    console.log("CRC handled");
    return response;
};

(process.env.NODE_ENV === 'production') && (exports.handleTwitterCrc = Sentry.AWSLambda.wrapHandler(exports.handleTwitterCrc));


module.exports.remind = async (event, context) => {
    const tweet = event.data;
    await Promise.all([
        twitter.replyWithReminder(tweet),
        service.cleanup(event.ruleName),
    ]);

    return http.success(`Reminded for tweet: ${JSON.stringify(tweet)}`);
};

(process.env.NODE_ENV === 'production') && (exports.remind = Sentry.AWSLambda.wrapHandler(exports.remind));


module.exports.checkForRemindersAndSend = async (event, context) => {
    let reminders = [];
    try {
        const key = getDateToNearestMinute().toISOString();
        reminders = await cache.lrangeAsync(key, 0, -1);
        reminders = reminders.map(JSON.parse);
        await Promise.all([
                ...reminders.map(service.remind),
            cache.delAsync(key)
        ]);
    } catch (err) {
        if (err instanceof (require("redis")).ReplyError) {
            console.log(`Redis error: ${err.command} ${err.args} ${err}`);
        }
        throw err;
    }

    return http.success(`Reminded for ${reminders.length} tweets`);
};

(process.env.NODE_ENV === 'production') && (exports.checkForRemindersAndSend = Sentry.AWSLambda.wrapHandler(exports.checkForRemindersAndSend));


module.exports.retryFailedTasks = async (event, context) => {
    const failedTasks = await cache.lrangeAsync(event.queue || 'PARSE_TIME_FAILURE', 0, -1);

    if (!failedTasks.length) {
        return http.success(`No tasks for retrying in queue ${event.queue}`);
    }

    await cache.delAsync(event.queue);
    let results = await Promise.all(failedTasks.map(service.parseReminderTime));
    await Promise.all(results.map(service.handleParsingResult));

    return http.success(`Retried ${failedTasks.length} tasks from ${event.queue} queue`);
};


module.exports.getPage = async (event, context) => {
    switch (event.pathParameters.page) {
        case 'login': {
            if (await auth.session(event)) {
                return http.redirect('/settings');
            }

            return http.redirect('/_/starttwittersignin');
        }

        case 'firebase-messaging-sw.js':
            return http.sendTextFile('firebase-messaging-sw.js', {'content-type': 'text/javascript; charset=UTF-8'});

        case 'settings': {
            const session = await auth.session(event);

            if (!session) {
                return http.redirect('/_/starttwittersignin');
            }

            const username = session.username;
            const settings = await getUserSettings(username);

            return http.render('settings', {username, settings, timezones});
        }
        
        default:
            return { statusCode: 404 };
    }
};

(process.env.NODE_ENV === 'production') && (exports.getPage = Sentry.AWSLambda.wrapHandler(exports.getPage, {
    timeoutWarningLimit: 2000,
}));


module.exports.getHomePage = async (event, context) => {
    return http.renderHtml('home');
};

(process.env.NODE_ENV === 'production') && (exports.getHomePage = Sentry.AWSLambda.wrapHandler(exports.getHomePage, {
    timeoutWarningLimit: 5000,
}));

module.exports.updateSettings = async (event, context) => {
    console.log(event.body);
    const session = await auth.session(event);
    if (!session) {
        return http.redirect('/_/starttwittersignin');
    }

    const username = session.username;
    const body = require('querystring').decode(event.body);
    
    const settings = await getUserSettings(username);
    if (body.utcOffset) {
        settings.utcOffset = body.utcOffset;
    }
    if (body['notifications.enabled']) {
        settings.notifications.enabled = body['notifications.enabled'] === '0' ? false : true;
    }
    if (body['notifications.fbtoken']) {
        settings.notifications.fbtoken = body['notifications.fbtoken'];
    }

    await setUserSettings(username, settings);

    return http.redirect('/settings');
};

(process.env.NODE_ENV === 'production') && (exports.updateSettings = Sentry.AWSLambda.wrapHandler(exports.updateSettings));


module.exports.startTwitterSignIn = async (event, context) => {
    const {
        oauth_token: requestToken,
        oauth_token_secret: requestTokenSecret,
        oauth_callback_confirmed
    } = await twitterSignIn.getRequestToken({
        x_auth_access_type: "read",
    });
    if (!oauth_callback_confirmed) {
        throw new Error('OAuth callback not confirmed!');
    }
    await cache.setAsync(`tokens-${requestToken}`, requestTokenSecret, 'EX', 5 * 60);
    return http.redirect('https://api.twitter.com/oauth/authenticate?oauth_token=' + requestToken);
};

(process.env.NODE_ENV === 'production') && (exports.startTwitterSignIn = Sentry.AWSLambda.wrapHandler(exports.startTwitterSignIn));


module.exports.completeTwitterSignIn = async (event, context) => {
    const requestToken = event.queryStringParameters.oauth_token;
    const oauthVerifier = event.queryStringParameters.oauth_verifier;

    const requestTokenSecret = await cache.getAsync(`tokens-${requestToken}`);
    const {oauth_token, oauth_token_secret, screen_name} =
        await twitterSignIn.getAccessToken(requestToken, requestTokenSecret, oauthVerifier);

    const user = await twitterSignIn.getUser(oauth_token, oauth_token_secret, {
        include_entities: false,
        skip_status: true,
    });

    const sessionId = await auth.createSession(user);

    return http.redirect('/settings', `rmotid=${sessionId}`);
};

(process.env.NODE_ENV === 'production') && (exports.completeTwitterSignIn = Sentry.AWSLambda.wrapHandler(exports.completeTwitterSignIn));
