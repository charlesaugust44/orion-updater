import UPnPClient from "node-upnp";
import he from "he";
import { parseString } from "xml2js";
import axios from "axios";
import { promises as fs } from "fs";
import EventEmitter from "events";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from 'url';

EventEmitter.defaultMaxListeners = 50;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPNP_CLASS_STORAGE_FOLDER = 'object.container.storageFolder';
const UPNP_CLASS_VIDEO_ITEM = 'object.item.videoItem';
const UPNP_SERVICE_ID_CONTENT = 'urn:upnp-org:serviceId:ContentDirectory';

const tmdbBaseURL = "https://api.themoviedb.org/3";
const dlnaBaseUrl = "http://192.168.2.104:8200";
const addonBaseUrl = "https://orion-dlna.vercel.app";

const configPath = path.join(__dirname, 'config.json');

const args = process.argv.slice(2);
const isForce = args.includes('--force');
const isDry = args.includes('--dry');

const DlnaClient = new UPnPClient({
    url: dlnaBaseUrl + '/rootDesc.xml'
});

const DlnaEventServer = DlnaClient.getEventsServer();

const torrentTerms = ['720p', '1080p', 'bluray', 'full hd', '5 1', 'x256', 'x265', 'rarbg', 'comandotorrents', 'x264', 'web dl', 'webdl', 'comando to', 'www bludv com'];
const torrentFilter = new RegExp(torrentTerms.join("|"), "gi");

async function loadConfig() {
    const data = await fs.readFile(configPath, 'utf8');
    return JSON.parse(data);
}

async function saveConfig(config) {
    const data = JSON.stringify(config, null, 4);
    await fs.writeFile(configPath, data, 'utf8');
}

async function tmdbSearch(query, type) {
    const config = await loadConfig();

    return (await axios.get(`/search/${type}`, {
        baseURL: tmdbBaseURL,
        params: {
            api_key: config.tmdb_key,
            query
        }
    })).data;
}

async function tmdbExternalSearch(id, type) {
    const config = await loadConfig();

    return (await axios.get(`/${type}/${id}/external_ids`, {
        baseURL: tmdbBaseURL,
        params: {
            api_key: config.tmdb_key
        }
    })).data;
}

async function pushVideoList(videoList) {
    const config = await loadConfig();

    return await axios.post(`/dlna`, videoList, {
        baseURL: addonBaseUrl,
        headers: {
            "x-orion-api-key": config.api_key
        }
    });
}

function extractSearchTitle(title) {
    const seasonMarker = /s(\d{1,2})e(\d{1,2})/i;
    const resolutionMarker = /1080p|720p/i;
    const yearMarker = /\b\d{4}\b$/;

    title = title.toLowerCase();

    if (seasonMarker.test(title)) {
        title = title.split(seasonMarker)[0];
    }

    if (resolutionMarker.test(title)) {
        title = title.split(resolutionMarker)[0];
    }

    return title
        .replaceAll(".", " ")
        .replaceAll("{", " ")
        .replaceAll("}", " ")
        .replaceAll("-", " ")
        .replace(torrentFilter, "")
        .trim()
        .replace(yearMarker, "")
        .replaceAll("  ", "")
        .replaceAll("   ", "")
        .trim();
}

function extractSeasonEpisode(input) {
    let match = input.match(/s(\d{1,2})e(\d{1,2})/i);

    if (!match) {
        return null;
    }

    return {
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10)
    };
}

function isBet(input) {
    return input.toLowerCase().includes("1xbet");
}

async function fetchDlnaVideos(objectID) {
    const browseArgs = {
        ObjectID: objectID,
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: 0,
        RequestedCount: 0,
        SortCriteria: ''
    };

    let results;

    try {
        const browseResponse = await DlnaClient.call(UPNP_SERVICE_ID_CONTENT, 'Browse', browseArgs);
        results = browseResponse.Result;
    } catch (error) {
        console.error('Error:', error);
        throw error;
    }

    return new Promise((resolve, reject) => {
        let callback = async (err, result) => {
            if (err) {
                console.error('Error parsing XML:', err);
                return reject(err);
            }

            const items = result['DIDL-Lite'].container || result['DIDL-Lite'].item || [];
            let videoList = [];

            for (const item of items) {
                if (item['upnp:class'][0] === UPNP_CLASS_STORAGE_FOLDER) {
                    try {
                        const childVideos = await fetchDlnaVideos(item.$.id);
                        videoList = videoList.concat(childVideos);
                    } catch (error) {
                        console.error('Error fetching child videos:', error);
                    }
                    continue;
                }

                if (item['upnp:class'][0] !== UPNP_CLASS_VIDEO_ITEM) {
                    continue;
                }

                if (isBet(item['dc:title'][0])) {
                    continue;
                }

                videoList.push({
                    filename: item['dc:title'][0],
                    show: extractSeasonEpisode(item['dc:title'][0]),
                    searchTitle: extractSearchTitle(item['dc:title'][0]),
                    url: item.res[0]._
                });
            }

            resolve(videoList);
        }

        parseString(he.decode(results), callback);
    });
}

async function fetchMetadata(videoList) {
    let metadata = [];
    for (const video of videoList) {
        const type = video.show ? 'tv' : 'movie';
        const searchResult = await tmdbSearch(video.searchTitle, type);

        if (searchResult.results.length === 0) {
            console.log(`🔴 ${video.searchTitle} | ${video.filename}`);
            continue;
        }

        const mainResult = searchResult.results[0];
        const title = mainResult.original_name ?? mainResult.original_title ?? mainResult.title;
        const externalResult = await tmdbExternalSearch(mainResult.id, type);
        console.log(`🟢 ${video.searchTitle} | ${video.filename} \n\t${title} - ${externalResult.imdb_id}`);

        metadata.push({
            title: title,
            imdb_id: externalResult.imdb_id,
            url: video.url,
            filename: video.filename,
            season: video.show ? video.show.season : null,
            episode: video.show ? video.show.episode : null,
        });
    }

    return metadata;
}

function getFormattedDate() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `[${year}-${month}-${day} ${hours}:${minutes}:${seconds}] `;
}

async function isDifferent(videoList) {
    const concatenatedNames = videoList.map(video => video.filename).join('');
    const hash = crypto.createHash('sha256');

    let config = await loadConfig();
    let hexHash = hash.update(concatenatedNames).digest('hex');

    if (config.last_update === hexHash) {
        return false;
    }

    config.last_update = hexHash;
    await saveConfig(config);

    return true;
}

async function run() {
    const videoList = await fetchDlnaVideos('2$15');
    await DlnaClient.removeAllListeners();

    if (!isForce && !await isDifferent(videoList)) {
        return;
    }

    console.log(getFormattedDate() + "Fetching metadata at TMDB.");
    const videoListMetadata = await fetchMetadata(videoList);

    if (isDry) {
        return;
    }

    console.log(getFormattedDate() + "Pushing data to Addon.");
    await pushVideoList(videoListMetadata);
}

run();
