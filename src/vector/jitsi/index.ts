/*
Copyright 2020 New Vector Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// We have to trick webpack into loading our CSS for us.
require("./index.scss");

import * as qs from 'querystring';
import {Capability, KnownWidgetActions, WidgetApi} from 'matrix-react-sdk/src/widgets/WidgetApi';
import {KJUR} from 'jsrsasign';
import {objectClone} from 'matrix-react-sdk/lib/utils/objects';

// Dev note: we use raw JS without many dependencies to reduce bundle size.
// We do not need all of React to render a Jitsi conference.

declare let JitsiMeetExternalAPI: any;

let inConference = false;

// Jitsi params
let jitsiDomain: string;
let conferenceId: string;
let displayName: string;
let avatarUrl: string;
let userId: string;
let jitsiAuth: string;
let roomId: string;
let openIDToken: string;

let widgetApi: WidgetApi;

function processOpenIDMessage(msg) {
    const data = (msg.action === 'get_openid') ? msg.response : msg.data;
    // TODO: just use data.state once https://github.com/matrix-org/matrix-react-sdk/pull/5172 is out
    const result = (data.state !== undefined) ? data.state :
        (data.success === true) ? 'allowed' : 'blocked';

    switch (result) {
        case 'allowed':
            console.info('Successfully got OpenID credentials.');
            openIDToken = data.access_token;
            // Send a response if this was not a response
            if (msg.action === 'openid_credentials') {
                const request = objectClone(msg);
                request.response = {};
                window.parent.postMessage(request, '*');
            }
            enableJoinButton();
            break;
        case 'blocked':
            console.warn('OpenID credentials request was blocked by user.');
            document.getElementById("widgetActionContainer").innerText = "Failed to load Jitsi widget";
            break;
        default:
           // nothing to do
    }
}

/**
 * Implements processing OpenID token requests as per MSC1960
 */
function onWidgetMessage(msg) {
    const data = msg.data;
    if (!data) {
        return;
    }
    switch (data.action) {
        case 'get_openid':
        case 'openid_credentials':
            processOpenIDMessage(data);
            break;
        default:
            // Nothing to do
    }
}

(async function() {
    try {
        // The widget's options are encoded into the fragment to avoid leaking info to the server. The widget
        // spec on the other hand requires the widgetId and parentUrl to show up in the regular query string.
        const widgetQuery = qs.parse(window.location.hash.substring(1));
        const query = Object.assign({}, qs.parse(window.location.search.substring(1)), widgetQuery);
        const qsParam = (name: string, optional = false): string => {
            if (!optional && (!query[name] || typeof (query[name]) !== 'string')) {
                throw new Error(`Expected singular ${name} in query string`);
            }
            return <string>query[name];
        };

        // If we have these params, expect a widget API to be available (ie. to be in an iframe
        // inside a matrix client). Otherwise, assume we're on our own, eg. have been popped
        // out into a browser.
        const parentUrl = qsParam('parentUrl', true);
        const widgetId = qsParam('widgetId', true);

        // Set this up as early as possible because Element will be hitting it almost immediately.
        if (parentUrl && widgetId) {
            widgetApi = new WidgetApi(qsParam('parentUrl'), qsParam('widgetId'), [
                Capability.AlwaysOnScreen,
            ]);
            widgetApi.expectingExplicitReady = true;
        }

        // Populate the Jitsi params now
        jitsiDomain = qsParam('conferenceDomain');
        conferenceId = qsParam('conferenceId');
        displayName = qsParam('displayName', true);
        avatarUrl = qsParam('avatarUrl', true); // http not mxc
        userId = qsParam('userId');
        jitsiAuth = qsParam('auth', true);
        roomId = qsParam('roomId', true);

        if (widgetApi) {
            await widgetApi.waitReady();
            await widgetApi.setAlwaysOnScreen(false); // start off as detachable from the screen

            // See https://github.com/matrix-org/prosody-mod-auth-matrix-user-verification
            if (jitsiAuth === 'openidtoken-jwt') {
                window.addEventListener('message', onWidgetMessage);
                widgetApi.callAction(
                    KnownWidgetActions.GetOpenIDCredentials,
                    {},
                    () => {},
                );
            } else {
                enableJoinButton();
            }
            // TODO: register widgetApi listeners for PTT controls (https://github.com/vector-im/riot-web/issues/12795)
        } else {
            enableJoinButton();
        }
    } catch (e) {
        console.error("Error setting up Jitsi widget", e);
        document.getElementById("widgetActionContainer").innerText = "Failed to load Jitsi widget";
    }
})();


function enableJoinButton() {
    document.getElementById("joinButton").onclick = () => joinConference();
}

function switchVisibleContainers() {
    inConference = !inConference;
    document.getElementById("jitsiContainer").style.visibility = inConference ? 'unset' : 'hidden';
    document.getElementById("joinButtonContainer").style.visibility = inConference ? 'hidden' : 'unset';
}

/**
 * Create a JWT token fot jitsi openidtoken-jwt auth
 *
 * See https://github.com/matrix-org/prosody-mod-auth-matrix-user-verification
 */
function createJWTToken() {
    // Header
    const header = {alg: 'HS256', typ: 'JWT'};
    // Payload
    const payload = {
        // As per Jitsi token auth, `iss` needs to be set to something agreed between
        // JWT generating side and Prosody config. Since we have no configuration for
        // the widgets, we can't set one anywhere. Using the Jitsi domain here probably makes sense.
        iss: jitsiDomain,
        sub: jitsiDomain,
        aud: `https://${jitsiDomain}`,
        room: "*",
        context: {
            matrix: {
                token: openIDToken,
                room_id: roomId,
            },
            user: {
                avatar: avatarUrl,
                name: displayName,
            },
        },
    };
    // Sign JWT
    // The secret string here is irrelevant, we're only using the JWT
    // to transport data to Prosody in the Jitsi stack.
    return KJUR.jws.JWS.sign(
        'HS256',
        JSON.stringify(header),
        JSON.stringify(payload),
        'notused',
    );
}

function joinConference() { // event handler bound in HTML
    switchVisibleContainers();

    // noinspection JSIgnoredPromiseFromCall
    if (widgetApi) widgetApi.setAlwaysOnScreen(true); // ignored promise because we don't care if it works

    console.warn(
        "[Jitsi Widget] The next few errors about failing to parse URL parameters are fine if " +
        "they mention 'external_api' or 'jitsi' in the stack. They're just Jitsi Meet trying to parse " +
        "our fragment values and not recognizing the options.",
    );
    const options = {
        width: "100%",
        height: "100%",
        parentNode: document.querySelector("#jitsiContainer"),
        roomName: conferenceId,
        interfaceConfigOverwrite: {
            SHOW_JITSI_WATERMARK: false,
            SHOW_WATERMARK_FOR_GUESTS: false,
            MAIN_TOOLBAR_BUTTONS: [],
            VIDEO_LAYOUT_FIT: "height",
        },
        jwt: undefined,
    };
    if (jitsiAuth === 'openidtoken-jwt') {
        options.jwt = createJWTToken();
    }
    const meetApi = new JitsiMeetExternalAPI(jitsiDomain, options);
    if (displayName) meetApi.executeCommand("displayName", displayName);
    if (avatarUrl) meetApi.executeCommand("avatarUrl", avatarUrl);
    if (userId) meetApi.executeCommand("email", userId);

    meetApi.on("readyToClose", () => {
        window.removeEventListener('message', onWidgetMessage);
        switchVisibleContainers();

        // noinspection JSIgnoredPromiseFromCall
        if (widgetApi) widgetApi.setAlwaysOnScreen(false); // ignored promise because we don't care if it works

        document.getElementById("jitsiContainer").innerHTML = "";
    });
}
