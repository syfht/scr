
require('dotenv').config();
const express = require("express");

const app = express();
const PORT = 3000;

// Basic route
app.get("/", (req, res) => {
  res.send("!Hello, World!");
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { igdl, youtube } = require('ab-downloader');

const CDN_DOMAINS = ['ax', 'cz', 'ct', 'cv', 'cm', 'cw', 'fi', 'sr', 'po', 'py', 'zz'];

const DOWNLOAD_SIZE_LIMIT = 2 * 1024 * 1024 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function parseAnimePage(animeUrl) {
    const { data } = await axios.get(animeUrl, {
        headers: { 'User-Agent': UA },
        timeout: 30000
    });
    const $ = cheerio.load(data);
    let animeName = $('.infotitle.c').first().text().trim();
    if (!animeName || animeName.length < 2) {
        animeName = $('title').text().trim()
            .replace(/\s*[-|].*AnimeHeaven.*/i, '')
            .replace(/\s*AnimeHeaven.*/i, '')
            .replace(/\s+me$/i, '')
            .trim();
    }
    if (!animeName || animeName.length < 2) {
        animeName = 'Unknown Anime';
    }
    if (animeName.includes('One Piece') || animeName.includes('Detective Conan')) return;
    const maxepMatch = data.match(/var\s+maxep\s*=\s*(\d+)/);
    const maxep = maxepMatch ? parseInt(maxepMatch[1]) : 0;
    const dfkeyMatch = data.match(/var\s+dfkey\s*=\s*"([^"]+)"/);
    const dfkey = dfkeyMatch ? dfkeyMatch[1] : null;
    return { animeName, maxep, dfkey, $, data };
}

function extractEpisodesFromPage($, data) {
    const episodes = [];
    const seen = new Set();
    $('a[onclick*="gate"]').each((i, el) => {
        const onclick = $(el).attr('onclick') || '';
        const onmouseover = $(el).attr('onmouseover') || '';
        const keyMatch = onclick.match(/gate[a-z]*\(["']([^"']+)["']\)/) ||
                         onmouseover.match(/gate[a-z]*\(["']([^"']+)["']\)/);
        if (!keyMatch) return;
        const key = keyMatch[1];
        if (seen.has(key)) return;
        const epText = $(el).find('.watch2').text().trim() ||
                       $(el).find('[class*="watch"]').text().trim();
        const epNumber = epText ? parseFloat(epText) : null;
        if (epNumber !== null && !isNaN(epNumber)) {
            seen.add(key);
            episodes.push({ number: epNumber, id: key });
        }
    });
    if (episodes.length === 0) {
        $('a[id][href*="gate"]').each((i, el) => {
            const id = $(el).attr('id');
            if (!id || id.length < 10 || seen.has(id)) return;
            const epText = $(el).find('.watch2').text().trim();
            const epNumber = epText ? parseFloat(epText) : null;
            if (epNumber !== null && !isNaN(epNumber)) {
                seen.add(id);
                episodes.push({ number: epNumber, id: id });
            }
        });
    }
    if (episodes.length === 0) {
        const gateaMatches = [...data.matchAll(/gate[a-z]*\(["']([a-f0-9]+)["']\)/g)];
        const watchMatches = [...data.matchAll(/<div class=["']watch2[^"']*["']>([\d.]+)<\/div>/g)];
        const uniqueKeys = [];
        const keySet = new Set();
        for (const m of gateaMatches) {
            if (!keySet.has(m[1])) {
                keySet.add(m[1]);
                uniqueKeys.push(m[1]);
            }
        }
        if (uniqueKeys.length > 0 && uniqueKeys.length === watchMatches.length) {
            for (let i = 0; i < uniqueKeys.length; i++) {
                const key = uniqueKeys[i];
                const epNumber = parseFloat(watchMatches[i][1]);
                if (!seen.has(key) && !isNaN(epNumber)) {
                    seen.add(key);
                    episodes.push({ number: epNumber, id: key });
                }
            }
        } else if (uniqueKeys.length > 0) {
            const epNums = [...data.matchAll(/Episode<\/div><div class=["']watch2[^"']*["']>([\d.]+)<\/div>/g)];
            if (epNums.length === uniqueKeys.length) {
                for (let i = 0; i < uniqueKeys.length; i++) {
                    episodes.push({ number: parseFloat(epNums[i][1]), id: uniqueKeys[i] });
                }
            } else {
                let epCounter = uniqueKeys.length;
                for (const key of uniqueKeys) {
                    episodes.push({ number: epCounter, id: key });
                    epCounter--;
                }
            }
        }
    }
    if (episodes.length > 0) {
        console.log(`📄 Page extraction found ${episodes.length} episodes directly from HTML`);
    } else {
        console.log('⚠️ Page extraction could not find any episodes in the HTML');
    }
    episodes.sort((a, b) => a.number - b.number);
    return episodes;
}

async function fetchEpisodeKeysFromGate(dfkey, maxep) {
    const episodes = [];
    let currentKey = dfkey;
    const visited = new Set();
    while (currentKey && !visited.has(currentKey)) {
        visited.add(currentKey);
        try {
            const { data } = await axios.get('https://animeheaven.me/gate.php', {
                headers: {
                    'User-Agent': UA,
                    'Cookie': 'key=' + currentKey,
                    'Referer': 'https://animeheaven.me/'
                },
                timeout: 15000
            });
            const epNumMatch = data.match(/Download\s+Episode\s+([\d.]+)/i);
            const epNumber = epNumMatch ? parseFloat(epNumMatch[1]) : null;
            if (epNumber !== null) {
                episodes.push({ number: epNumber, id: currentKey });
                console.log('\u2705 Gate: Episode ' + epNumber + ' key=' + currentKey.substring(0, 8) + '...');
            }
            const prevMatches = [...data.matchAll(/gate\("([^"]+)"\)/g)];
            let prevKey = null;
            for (const m of prevMatches) {
                const candidateKey = m[1];
                if (!visited.has(candidateKey) && candidateKey !== currentKey) {
                    const idx = data.indexOf(m[0]);
                    const afterText = data.substring(idx + m[0].length, idx + m[0].length + 80);
                    const nearbyEpMatch = afterText.match(/Episode\s+([\d.]+)/i);
                    if (nearbyEpMatch) {
                        const nearbyEp = parseFloat(nearbyEpMatch[1]);
                        if (epNumber !== null && nearbyEp < epNumber) {
                            prevKey = candidateKey;
                            break;
                        }
                    }
                    if (!prevKey) prevKey = candidateKey;
                }
            }
            currentKey = prevKey;
            if (currentKey) {
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (error) {
            console.error('Error fetching gate.php for key ' + currentKey + ':', error.message);
            break;
        }
    }
    episodes.sort((a, b) => a.number - b.number);
    if (maxep > 0 && episodes.length < maxep) {
        console.log(`⚠️ Gate crawl found ${episodes.length}/${maxep} episodes (some may have been missed)`);
    }
    return episodes;
}


const client = new Client({
    checkUpdate: false
});

// Target channel for anime info
const ANIME_INFO_CHANNEL_ID = "1492085884756033618";

// Multiple categories for anime channels - ADD ALL YOUR CATEGORY IDs HERE
const ANIME_CATEGORIES = [
    "1492086104709660902", "1492086147340566559", "1492086175609917493",
  "1492086213660643481", "1492086260775391282", "1492086295529263164"
];

// Global CDN state tracker
let currentWorkingCDN = null;
let cdnFailCount = 0;
let lastCdnSwitchTime = Date.now();
const cdnSuccessHistory = {};

function formatAnimeEntry(index, anime) {
    let entry = `**${index}.** ${anime.englishTitle}\n`;

    if (anime.japaneseTitle && anime.japaneseTitle !== 'N/A' && anime.japaneseTitle !== anime.englishTitle) {
        const jpTitle = anime.japaneseTitle.length > 40 ? 
            anime.japaneseTitle.substring(0, 37) + '...' : 
            anime.japaneseTitle;
        entry += `   🇯🇵 *${jpTitle}*\n`;
    }

    const epDisplay = anime.episodeCount !== '?' ? `📊 Ep ${anime.episodeCount}` : '⏳ Airing';
    const timeDisplay = anime.timeRemaining && anime.timeRemaining !== 'N/A' && anime.timeRemaining !== 'Unknown' 
        ? ` ⏰ ${anime.timeRemaining}` : '';

    entry += `   ${epDisplay}${timeDisplay}\n`;
    entry += `   🔗 \`${anime.url}\`\n\n`;

    return entry;
}

async function fetchLatestAnime() {
    try {
        console.log('🔍 Fetching latest anime from animeheaven.me...');

        const { data } = await axios.get('https://animeheaven.me/', {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 30000
        });

        const $ = cheerio.load(data);
        const latestAnime = [];

        console.log("🔍 Parsing latest anime...");

        // Look for chart divs (these appear to be the latest/scheduled anime)
        $('div.chart.bc1').each((i, element) => {
            if (i >= 10) return false; // Limit to 10 results

            const $chart = $(element);

            // Extract anime URL and ID
            const animeLink = $chart.find('a[href^="anime.php?"]').first();
            const href = animeLink.attr('href');

            if (href) {
                // Extract anime title (English title)
                let englishTitle = $chart.find('.charttitle a').text().trim();

                // Extract Japanese/alternative title
                let japaneseTitle = $chart.find('.charttitlejp').text().trim();

                // Extract episode count
                let episodeCount = $chart.find('.chartepm').text().trim() || 
                                  $chart.find('.chartep').first().text().trim();

                // Extract time until next episode (if available)
                let timeRemaining = $chart.find('.charttimer').text().trim();

                // Extract image URL
                let imageUrl = '';
                const img = $chart.find('img.coverimg');
                if (img.length) {
                    let src = img.attr('src');
                    if (src) {
                        if (src.startsWith('http')) {
                            imageUrl = src;
                        } else {
                            imageUrl = `https://animeheaven.me/${src}`;
                        }
                    }
                }

                // Extract alt text (sometimes contains title)
                const altText = $chart.find('img.coverimg').attr('alt') || '';

                // If english title is empty, try alt text
                if (!englishTitle && altText) {
                    englishTitle = altText;
                }

                // Clean up titles
                englishTitle = englishTitle
                    .replace(/\s*\|\s*AnimeHeaven$/, '')
                    .replace(/AnimeHeaven$/, '')
                    .replace(/\s*-\s*animeheaven\.me$/, '')
                    .replace(/^\s+|\s+$/g, '');

                if (englishTitle && englishTitle.length > 1) {
                    const animeUrl = `https://animeheaven.me/${href}`;

                    latestAnime.push({
                        englishTitle: englishTitle,
                        japaneseTitle: japaneseTitle || 'N/A',
                        episodeCount: episodeCount || '?',
                        timeRemaining: timeRemaining || 'Unknown',
                        imageUrl: imageUrl,
                        url: animeUrl,
                        altText: altText
                    });

                    console.log(`✅ Found: "${englishTitle}" (Ep ${episodeCount})`);
                }
            }
        });

        // If no results found with chart class, try alternative selectors
        if (latestAnime.length === 0) {
            console.log("Trying alternative selectors...");

            // Look for any anime links in the main content
            $('a[href^="anime.php?"]').each((i, element) => {
                if (i >= 10) return false;

                const $el = $(element);
                const href = $el.attr('href');
                let title = $el.text().trim();

                // Try to find parent container with more info
                const $container = $el.closest('div[class*="chart"], div[class*="similar"], div[class*="info"]');

                if ($container.length) {
                    const episodeCount = $container.find('.chartep, .episode-count, .ep').first().text().trim();
                    const japaneseTitle = $container.find('.charttitlejp, .japanese-title').first().text().trim();

                    if (title && title.length > 1) {
                        latestAnime.push({
                            englishTitle: title,
                            japaneseTitle: japaneseTitle || 'N/A',
                            episodeCount: episodeCount || '?',
                            timeRemaining: 'N/A',
                            url: `https://animeheaven.me/${href}`
                        });

                        console.log(`✅ Found (alt): "${title}"`);
                    }
                } else if (title && title.length > 1) {
                    latestAnime.push({
                        englishTitle: title,
                        japaneseTitle: 'N/A',
                        episodeCount: '?',
                        timeRemaining: 'N/A',
                        url: `https://animeheaven.me/${href}`
                    });

                    console.log(`✅ Found (direct): "${title}"`);
                }
            });
        }

        // Remove duplicates by URL
        const uniqueAnime = [];
        const urlSet = new Set();

        for (const anime of latestAnime) {
            if (!urlSet.has(anime.url)) {
                urlSet.add(anime.url);
                uniqueAnime.push(anime);
            }
        }

        console.log(`📊 Found ${uniqueAnime.length} unique latest anime`);
        return uniqueAnime.slice(0, 10);

    } catch (error) {
        console.error('Error fetching latest anime:', error);
        throw new Error(`Failed to fetch latest anime: ${error.message}`);
    }
}

async function checkEpisodeInChannel(channel, episodeNumber) {
    try {
        // Fetch recent messages (limit to 100 to avoid rate limits)
        const messages = await channel.messages.fetch({ limit: 100 });

        // Look for messages containing the episode
        const episodePattern = new RegExp(`Episode[\\s_-]*${episodeNumber}`, 'i');

        for (const msg of messages.values()) {
            // Check message content
            if (episodePattern.test(msg.content)) {
                return true;
            }

            // Check attachments (files)
            if (msg.attachments.size > 0) {
                for (const attachment of msg.attachments.values()) {
                    if (episodePattern.test(attachment.name)) {
                        return true;
                    }
                }
            }
        }

        return false;
    } catch (error) {
        console.error(`Error checking channel ${channel.name} for episode ${episodeNumber}:`, error);
        return false; // Assume not found on error
    }
}

async function getLatestEpisodeNumber(animeUrl) {
    try {
        const { maxep } = await parseAnimePage(animeUrl);
        return maxep > 0 ? maxep : null;
    } catch (error) {
        console.error('Error getting latest episode number:', error);
        return null;
    }
}

async function getAllEpisodesFromPage(animeUrl) {
    try {
        const { maxep, dfkey, $, data } = await parseAnimePage(animeUrl);
        let episodes = [];
        if (dfkey && maxep > 0) {
            episodes = await fetchEpisodeKeysFromGate(dfkey, maxep);
        }
        if (episodes.length === 0) {
            console.log('Gate crawl returned 0 episodes, trying direct page extraction...');
            episodes = extractEpisodesFromPage($, data);
            if (episodes.length > 0) {
                console.log(`✅ Direct page extraction found ${episodes.length} episodes`);
            }
        }
        return episodes;
    } catch (error) {
        console.error('Error getting all episodes from page:', error);
        return [];
    }
}

async function getAllPostedEpisodes(channel) {
    const postedEpisodes = new Set();
    const episodePattern = /Episode[\s_-]*(\d+\.?\d*)/gi;
    let lastMessageId = null;

    try {
        while (true) {
            const options = { limit: 100 };
            if (lastMessageId) options.before = lastMessageId;

            const messages = await channel.messages.fetch(options);
            if (messages.size === 0) break;

            for (const msg of messages.values()) {
                if (msg.attachments.size === 0) continue;

                for (const attachment of msg.attachments.values()) {
                    if (!attachment.name) continue;
                    let match;
                    episodePattern.lastIndex = 0;
                    while ((match = episodePattern.exec(attachment.name)) !== null) {
                        postedEpisodes.add(parseFloat(match[1]));
                    }
                }
            }

            lastMessageId = messages.last().id;
            if (messages.size < 100) break;
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (error) {
        console.error(`Error fetching all posted episodes from ${channel.name}:`, error);
    }

    return postedEpisodes;
}

// Modified findOrCreateAnimeChannel function to accept category list
async function findOrCreateAnimeChannelWithFallback(guild, animeName, animeInfo = null, attemptedCategories = []) {
    try {
        // Format channel name
        let channelName = animeName
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 100);

        if (!channelName || channelName.length < 2) {
            channelName = `anime-${Date.now()}`;
        }

        // Try each category in order
        for (const categoryId of ANIME_CATEGORIES) {
            // Skip categories we've already tried
            if (attemptedCategories.includes(categoryId)) {
                continue;
            }

            // Get the category
            const category = guild.channels.cache.get(categoryId);
            if (!category) {
                console.log(`Category ${categoryId} not found, skipping...`);
                continue;
            }

            console.log(`Trying category: ${category.name} (${categoryId})`);

            // Check if channel already exists in this category
            const existingChannel = category.children.find(c => 
                c.name === channelName || c.name.includes(channelName)
            );

            if (existingChannel) {
                console.log(`✅ Found existing channel in category ${category.name}: ${existingChannel.name}`);
                return {
                    success: true,
                    channel: existingChannel,
                    categoryId: categoryId,
                    categoryName: category.name
                };
            }

            // Try to create new channel in this category
            try {
                console.log(`📝 Creating new channel in category ${category.name}: ${channelName}`);
                const newChannel = await guild.channels.create(channelName, {
                    type: 'GUILD_TEXT',
                    parent: categoryId,
                    topic: `Downloads for ${animeName}`
                });

                console.log(`✅ Created channel in category ${category.name}: ${newChannel.name}`);

                // Send anime info if available
                if (animeInfo) {
                    try {
                        const infoChannel = await client.channels.fetch(ANIME_INFO_CHANNEL_ID);
                        if (infoChannel) {
                            const infoText = 
                                `Name: ${animeInfo.name}\n` +
                                `Synopsis: ${animeInfo.synopsis}\n\n` +
                                `Genres: ${animeInfo.genres}\n` +
                                `Synonyms: ${animeInfo.synonyms}\n` +
                                `ImageURL: ${animeInfo.imageUrl}`

                            await infoChannel.send(infoText);
                            console.log(`✅ Sent anime info to channel ${ANIME_INFO_CHANNEL_ID}`);
                        }
                    } catch (infoError) {
                        console.error('Error sending anime info:', infoError);
                    }
                }

                return {
                    success: true,
                    channel: newChannel,
                    categoryId: categoryId,
                    categoryName: category.name
                };

            } catch (createError) {
                console.error(`Failed to create channel in category ${categoryId}:`, createError.message);
                // Continue to next category
                continue;
            }
        }

        // If we get here, all categories failed
        console.error('All categories failed for channel creation');
        return {
            success: false,
            channel: null,
            categoryId: null,
            categoryName: null,
            error: 'No available categories found'
        };

    } catch (error) {
        console.error('Error in findOrCreateAnimeChannelWithFallback:', error);
        return {
            success: false,
            channel: null,
            categoryId: null,
            categoryName: null,
            error: error.message
        };
    }
}

// Modified createAnimeChannel function with category fallback
async function createAnimeChannelWithFallback(animeName, guild, attemptedCategories = []) {
    try {
        // Format channel name
        let channelName = animeName
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .substring(0, 100);

        if (!channelName || channelName.length < 2) {
            channelName = `anime-${Date.now()}`;
        }

        // Try each category in order
        for (const categoryId of ANIME_CATEGORIES) {
            // Skip categories we've already tried
            if (attemptedCategories.includes(categoryId)) {
                continue;
            }

            const category = guild.channels.cache.get(categoryId);
            if (!category) {
                console.log(`Category ${categoryId} not found, skipping...`);
                continue;
            }

            console.log(`📝 Creating channel in category ${category.name}: ${channelName}`);

            try {
                const newChannel = await guild.channels.create(channelName, {
                    type: 'GUILD_TEXT',
                    parent: categoryId,
                    topic: `Downloads for ${animeName}`
                });

                console.log(`✅ Created channel in category ${category.name}: ${newChannel.name}`);
                return {
                    success: true,
                    channel: newChannel,
                    categoryId: categoryId,
                    categoryName: category.name
                };

            } catch (createError) {
                console.error(`Failed to create channel in category ${categoryId}:`, createError.message);
                // Continue to next category
                continue;
            }
        }

        // If we get here, all categories failed
        return {
            success: false,
            channel: null,
            categoryId: null,
            categoryName: null,
            error: 'No available categories found'
        };

    } catch (error) {
        console.error('Error in createAnimeChannelWithFallback:', error);
        return {
            success: false,
            channel: null,
            categoryId: null,
            categoryName: null,
            error: error.message
        };
    }
}

async function fetchAnimeInfo(animeUrl) {
    try {
        console.log(`🔍 Fetching anime info from: ${animeUrl}`);

        const { data } = await axios.get(animeUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 30000
        });

        const $ = cheerio.load(data);
        let animeName = $('.infotitle.c').first().text().trim();
        if (!animeName || animeName.length < 2) {
            animeName = $('title').text().trim()
                .replace(/\s*[-|].*AnimeHeaven.*/i, '')
                .replace(/\s*AnimeHeaven.*/i, '')
                .replace(/\s+me$/i, '')
                .trim();
        }
        if (!animeName || animeName.length < 2) animeName = 'Unknown Anime';

        // Extract synopsis from infodes class
        let synopsis = $('.infodes.c').first().text().trim();

        // If not found, try alternative selectors
        if (!synopsis) {
            synopsis = $('.description, .synopsis, .info').first().text().trim();
        }

        // Extract genres from genre.php links
        const genres = [];
        $('a[href^="genre.php?"]').each((i, el) => {
            const genre = $(el).text().trim();
            if (genre && !genres.includes(genre)) {
                genres.push(genre);
            }
        });

        // Extract tags from infotags class
        const tags = [];
        $('.infotags.c a[href^="tags.php?"]').each((i, el) => {
            const tag = $(el).find('.boxitem').text().trim() || $(el).text().trim();
            if (tag && !tags.includes(tag)) {
                tags.push(tag);
            }
        });

        // If tags not found with the specific selector, try a more general approach
        if (tags.length === 0) {
            $('.infotags a').each((i, el) => {
                const tag = $(el).text().trim().replace(/^Tags:\s*/, '');
                if (tag && tag.length > 0 && !tags.includes(tag) && tag !== 'Tags:') {
                    tags.push(tag);
                }
            });
        }

        // Extract synonyms/alternative titles
        const synonyms = [];
        $('b:contains("Synonyms:")').each((i, el) => {
            const synText = $(el).parent().text().replace('Synonyms:', '').trim();
            if (synText) {
                synonyms.push(synText);
            }
        });

        // If synonyms not found with b tag, try other selectors
        if (synonyms.length === 0) {
            $('.info2').each((i, el) => {
                const text = $(el).text();
                if (text.includes('Synonyms:')) {
                    const synText = text.split('Synonyms:')[1].split('\n')[0].trim();
                    if (synText) {
                        synonyms.push(synText);
                    }
                }
            });
        }

        // Extract image URL
        let imageUrl = '';

        // Look for posterimg class first
        $('img.posterimg').each((i, el) => {
            const src = $(el).attr('src');
            if (src) {
                if (src.startsWith('http')) {
                    imageUrl = src;
                } else {
                    imageUrl = `https://animeheaven.me/${src}`;
                }
                console.log(`✅ Found poster image: ${imageUrl}`);
                return false; // Break the loop
            }
        });

        // If not found with posterimg, try coverimg class
        if (!imageUrl) {
            $('img.coverimg').each((i, el) => {
                const src = $(el).attr('src');
                if (src) {
                    if (src.startsWith('http')) {
                        imageUrl = src;
                    } else {
                        imageUrl = `https://animeheaven.me/${src}`;
                    }
                    console.log(`✅ Found cover image: ${imageUrl}`);
                    return false;
                }
            });
        }

        // If still not found, try any image with anime-related alt text
        if (!imageUrl) {
            $('img').each((i, el) => {
                const src = $(el).attr('src');
                const alt = $(el).attr('alt') || '';
                if (src && (alt.includes('Poster') || alt.includes('Cover') || alt.includes(animeName.split(' ')[0]))) {
                    if (src.startsWith('http')) {
                        imageUrl = src;
                    } else {
                        imageUrl = `https://animeheaven.me/${src}`;
                    }
                    console.log(`✅ Found image via alt text: ${imageUrl}`);
                    return false;
                }
            });
        }

        // Final fallback - try to find any image in a poster container
        if (!imageUrl) {
            $('.poster img, .cover img, .anime-poster img').each((i, el) => {
                const src = $(el).attr('src');
                if (src) {
                    if (src.startsWith('http')) {
                        imageUrl = src;
                    } else {
                        imageUrl = `https://animeheaven.me/${src}`;
                    }
                    console.log(`✅ Found image in poster container: ${imageUrl}`);
                    return false;
                }
            });
        }

        return {
            name: animeName,
            synopsis: synopsis || 'No synopsis available',
            genres: genres.length > 0 ? genres.join(', ') : '+',
            tags: tags.length > 0 ? tags.join(', ') : 'No tags available',
            synonyms: synonyms.length > 0 ? synonyms.join(', ') : 'Not available',
            imageUrl: imageUrl || 'No image available',
            url: animeUrl
        };

    } catch (error) {
        console.error('Error fetching anime info:', error);
        return null;
    }
}

async function searchAnimeList(animeName) {
    try {
        console.log(`🔍 Searching for anime: "${animeName}"`);

        // Format anime name for URL
        const searchQuery = animeName.replace(/\s+/g, '+');
        const searchUrl = `https://animeheaven.me/search.php?s=${searchQuery}`;

        console.log(`🔗 Search URL: ${searchUrl}`);

        const { data } = await axios.get(searchUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 30000
        });

        const $ = cheerio.load(data);
        const results = [];

        console.log("🔍 Parsing search results...");

        // Method 1: Look for div.similarimg containers
        $('div.similarimg').each((i, container) => {
            const $container = $(container);

            // Find anime link
            const animeLink = $container.find('a[href^="anime.php?"]').first();
            const href = animeLink.attr('href');

            if (href) {
                // Get anime title from multiple possible sources:
                let animeTitle = '';

                // 1. Try from similarname class (most reliable)
                const similarnameText = $container.find('.similarname').text().trim();
                if (similarnameText) {
                    animeTitle = similarnameText;
                }

                // 2. Try from img alt attribute
                if (!animeTitle) {
                    const imgAlt = $container.find('img.coverimg').attr('alt');
                    if (imgAlt) {
                        animeTitle = imgAlt;
                    }
                }

                // 3. Try from link text
                if (!animeTitle) {
                    animeTitle = animeLink.text().trim();
                }

                // Clean up the title
                if (animeTitle) {
                    animeTitle = animeTitle
                        .replace(/\s*\|\s*AnimeHeaven$/, '')
                        .replace(/AnimeHeaven$/, '')
                        .replace(/\s*-\s*animeheaven\.me$/, '')
                        .replace(/^\s+|\s+$/g, '');

                    const animeUrl = `https://animeheaven.me/${href}`;

                    results.push({
                        title: animeTitle,
                        url: animeUrl
                    });

                    console.log(`✅ Found: "${animeTitle}" -> ${animeUrl}`);
                }
            }
        });

        // Method 2: Look for anime links directly if first method didn't work
        if (results.length === 0) {
            $('a[href^="anime.php?"]').each((i, el) => {
                const $el = $(el);
                const href = $el.attr('href');
                let animeTitle = $el.text().trim();

                // If title is empty, check parent elements
                if (!animeTitle || animeTitle.length < 2) {
                    animeTitle = $el.closest('.similarname').text().trim() ||
                                $el.parent().text().trim() ||
                                $el.closest('.p1').text().trim();
                }

                // Clean up title
                if (animeTitle && animeTitle.length > 1) {
                    animeTitle = animeTitle
                        .replace(/\s*\|\s*AnimeHeaven$/, '')
                        .replace(/AnimeHeaven$/, '')
                        .replace(/\s*-\s*animeheaven\.me$/, '')
                        .replace(/^\s+|\s+$/g, '');

                    // Skip if it's just "Watch" or similar
                    if (!animeTitle.match(/^(Watch|Episode|Ep|Season|S\d+)$/i) && 
                        animeTitle.length > 3) {

                        const animeUrl = `https://animeheaven.me/${href}`;
                        results.push({
                            title: animeTitle,
                            url: animeUrl
                        });

                        console.log(`✅ Found (direct): "${animeTitle}" -> ${animeUrl}`);
                    }
                }
            });
        }

        // Remove duplicates by URL
        const uniqueResults = [];
        const urlSet = new Set();

        for (const result of results) {
            if (!urlSet.has(result.url)) {
                urlSet.add(result.url);
                uniqueResults.push(result);
            }
        }

        console.log(`📊 Found ${uniqueResults.length} unique results`);

        return uniqueResults.slice(0, 15); // Limit to 15 results

    } catch (error) {
        console.error('Search error:', error);
        throw new Error(`Search failed: ${error.message}`);
    }
}

async function downloadYT(url, filename = 'youtube_video.mp4') {
    try {
        // Get video data from ab-downloader
        const data = await youtube(url);

        console.log('✅ YouTube video data received!');

        // Check what data structure ab-downloader returns
        let videoUrl;

        if (data && data.url) {
            videoUrl = data.url;
        } else if (data && data[0] && data[0].url) {
            videoUrl = data[0].url; // Similar to Instagram structure
        } else if (typeof data === 'string') {
            videoUrl = data; // If it returns direct URL
        } else if (data && data.mp4) {
            videoUrl = data.mp4; // YouTube often returns mp4 property
        } else {
            console.log('Data structure:', data); // Log to see the structure
            throw new Error('Could not find video URL in response');
        }

        // Download the video
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(filename);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`✅ YouTube video saved as: ${filename}`);
                resolve(filename);
            });
            writer.on('error', reject);
        });

    } catch (error) {
        console.error('YouTube download error:', error.message);
        throw error;
    }
}

async function downloadIG(url, filename = 'instagram_reel.mp4') {
    try {
        // Get video data
        const data = await igdl(url);

        if (!data || data.length === 0) {
            throw new Error('No video found');
        }

        const videoUrl = data[0].url;

        // Download the video
        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(filename);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`✅ Video saved as: ${filename}`);
                resolve(filename);
            });
            writer.on('error', reject);
        });

    } catch (error) {
        console.error('Error:', error.message);
        throw error;
    }
}

// Function to search for anime and get the URL
async function searchAnime(animeName) {
    try {
        console.log(`🔍 Searching for anime: "${animeName}"`);

        // Format anime name for URL (replace spaces with +)
        const searchQuery = animeName.replace(/\s+/g, '+');
        const searchUrl = `https://animeheaven.me/search.php?s=${searchQuery}`;

        console.log(`🔗 Search URL: ${searchUrl}`);

        const { data } = await axios.get(searchUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 30000
        });

        const $ = cheerio.load(data);

        // Look for the anime URL in the search results
        let animeUrl = null;

        // Try multiple selectors to find the first anime link
        const selectors = [
            'a[href^="anime.php?"]',
            '.similarimg a[href^="anime.php?"]',
            '.info3 a[href^="anime.php?"]',
            '.p1 a[href^="anime.php?"]'
        ];

        for (const selector of selectors) {
            const firstLink = $(selector).first();
            const href = firstLink.attr('href');

            if (href && href.startsWith('anime.php?')) {
                animeUrl = `https://animeheaven.me/${href}`;
                const animeTitle = firstLink.text().trim() || firstLink.find('.similarname').text().trim() || 'Unknown Anime';
                console.log(`✅ Found anime: "${animeTitle}" at URL: ${animeUrl}`);
                break;
            }
        }

        // Alternative: Look for the div with anime name and extract URL
        if (!animeUrl) {
            $(`.linetitle:contains("${animeName.toLowerCase()}"), .similarname a`).each((i, el) => {
                if (!animeUrl) {
                    const $el = $(el);
                    const href = $el.attr('href');
                    if (href && href.startsWith('anime.php?')) {
                        animeUrl = `https://animeheaven.me/${href}`;
                        console.log(`✅ Found anime via alternative selector: ${animeUrl}`);
                        return false; // Break the loop
                    }
                }
            });
        }

        if (!animeUrl) {
            console.log('❌ No anime found in search results');
            return null;
        }

        return animeUrl;

    } catch (error) {
        console.error('Search error:', error);
        return null;
    }
}

// Function to send episodes to a channel
async function sendEpisodesToChannelWithCategory(folderPath, animeName, channel, startMessage) {
    try {
        // Get all MP4 files in the folder
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.mp4'))
            .sort((a, b) => {
                const epNumA = parseFloat((a.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '0').replace('-', '.'));
                const epNumB = parseFloat((b.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '0').replace('-', '.'));
                return epNumA - epNumB;
            });

        if (files.length === 0) {
            await channel.send(`❌ No MP4 files found in folder for ${animeName}!`);
            return { sent: 0, failed: 0, channel: channel };
        }

        // Update status
        const categoryName = channel.parent ? channel.parent.name : 'Unknown Category';

        if (startMessage) {
            await startMessage.edit(`📤 **Starting upload of ${files.length} episodes to ${channel} (Category: ${categoryName})...**`);
        } else {
            await channel.send(`📤 **Starting upload of ${files.length} episodes for ${animeName} to category ${categoryName}...**`);
        }

        let sentCount = 0;
        let failedCount = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const filePath = path.join(folderPath, file);
            const epNum = (file.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '').replace('-', '.');
            const fileSize = fs.statSync(filePath).size;
            const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);

            try {
                const statusMsg = await channel.send(
                    `📤 **Uploading:** Episode ${epNum}\n` +
                    `📊 **Progress:** ${i}/${files.length}\n` +
                    `💾 **Size:** ${fileSizeMB}MB\n` +
                    `📁 **Category:** ${categoryName}\n` +
                    `⏳ **Status:** Uploading...`
                );

                console.log(`📤 Uploading ${animeName} - Episode ${epNum} to category ${categoryName}...`);

                await channel.send({
                    content: `**${animeName} - Episode ${epNum}** (${i + 1}/${files.length})`,
                    files: [filePath]
                });

                sentCount++;
                await statusMsg.delete().catch(() => {});
                console.log(`✅ Uploaded ${animeName} - Episode ${epNum} to category ${categoryName}`);

                if (i < files.length - 1) {
                    const delay = 500 + Math.random() * 500;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

            } catch (error) {
                failedCount++;
                console.error(`❌ Failed to upload ${animeName} - Episode ${epNum}:`, error.message);
                await channel.send(`❌ **Failed to upload Episode ${epNum}:** ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Final status
        if (failedCount === 0) {
            await channel.send(`✅ **Successfully uploaded all ${sentCount} episodes of ${animeName} to category ${categoryName}!**`);
        } else {
            await channel.send(
                `📤 **Upload Complete to category ${categoryName}**\n` +
                `✅ **Successful:** ${sentCount} episodes\n` +
                `❌ **Failed:** ${failedCount} episodes`
            );
        }

        return { 
            sent: sentCount, 
            failed: failedCount, 
            channel: channel,
            categoryName: categoryName 
        };

    } catch (error) {
        console.error('Error in sendEpisodesToChannelWithCategory:', error);
        await channel.send(`❌ **Error uploading episodes:** ${error.message}`);
        return { sent: 0, failed: 0, channel: channel, categoryName: 'Unknown' };
    }
}

function getFolderSize(folderPath) {
    if (!fs.existsSync(folderPath)) return 0;
    let totalSize = 0;
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
        const filePath = path.join(folderPath, file);
        try {
            const stats = fs.statSync(filePath);
            if (stats.isFile()) totalSize += stats.size;
        } catch (e) {}
    }
    return totalSize;
}

async function uploadAndCleanBatch(folder, animeName, animeChannel, channel, batchNumber) {
    const files = fs.readdirSync(folder)
        .filter(file => file.endsWith('.mp4'))
        .sort((a, b) => {
            const epNumA = parseFloat((a.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '0').replace('-', '.'));
            const epNumB = parseFloat((b.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '0').replace('-', '.'));
            return epNumA - epNumB;
        });

    if (files.length === 0) return { sent: 0, failed: 0 };

    const totalSizeMB = (getFolderSize(folder) / (1024 * 1024)).toFixed(1);
    await channel.send(`📤 **Batch ${batchNumber}: Uploading ${files.length} episodes (${totalSizeMB}MB) to ${animeChannel} (11GB limit reached)...**`);

    let sentCount = 0;
    let failedCount = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = path.join(folder, file);
        const epNum = (file.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '').replace('-', '.');

        try {
            await animeChannel.send({
                content: `**${animeName} - Episode ${epNum}**`,
                files: [filePath]
            });
            sentCount++;
            console.log(`✅ Batch ${batchNumber}: Uploaded Episode ${epNum}`);

            try {
                fs.unlinkSync(filePath);
            } catch (e) {}

            if (i < files.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
            }
        } catch (error) {
            failedCount++;
            console.error(`❌ Batch ${batchNumber}: Failed to upload Episode ${epNum}:`, error.message);
            await animeChannel.send(`❌ **Failed to upload Episode ${epNum}:** ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    await channel.send(`✅ **Batch ${batchNumber} complete:** ${sentCount} uploaded, ${failedCount} failed. Continuing download...`);
    return { sent: sentCount, failed: failedCount };
}

async function loopDownloadAnimeSeries(animeUrl, channel, startEpisode = 1, animeChannel = null) {
    let progressMsg = null;

    try {
        progressMsg = await channel.send(`Launching DarrkOS (Loop Mode)...`);

        console.log(`🔍 Fetching: ${animeUrl}`);
        const { animeName: parsedName, maxep, dfkey, $, data } = await parseAnimePage(animeUrl);

        let animeName = parsedName;

        if (!animeName || animeName.length < 2) {
            animeName = $('h1').first().text().trim() || 'Unknown Anime';
        }

        console.log(`Cleaned anime name: "${animeName}"`);

        const safeName = animeName
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, "_")
            .replace(/[^a-zA-Z0-9_]/g, '')
            .toLowerCase();

        const folder = `./${safeName}`;
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }

        await progressMsg.edit(`📺 **Anime:** ${animeName}\n🔄 Gathering episode information...`);

        console.log(`Fetching episode keys via gate.php (maxep=${maxep})...`);
        let episodes;
        if (dfkey && maxep > 0) {
            episodes = await fetchEpisodeKeysFromGate(dfkey, maxep);
        } else {
            episodes = [];
        }

        if (episodes.length === 0) {
            console.log('Gate crawl returned 0 episodes, trying direct page extraction...');
            episodes = extractEpisodesFromPage($, data);
            if (episodes.length > 0) {
                console.log(`✅ Direct page extraction found ${episodes.length} episodes`);
            }
        }

        if (episodes.length === 0) {
            throw new Error('No episodes found. Could not extract episode keys from the website.');
        }

        episodes.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));

        const filteredEpisodes = episodes.filter(ep => parseFloat(ep.number) >= startEpisode);
        const totalEpisodes = episodes.length;
        const episodesToDownload = filteredEpisodes.length;

        if (episodesToDownload === 0) {
            throw new Error(`No episodes found starting from episode ${startEpisode}`);
        }

        await progressMsg.edit(
            `==== DarrkOS (Loop Mode) ====\n` +
            `📺 **Anime:** ${animeName}\n` +
            `📊 **Total episodes:** ${totalEpisodes}\n` +
            (startEpisode > 1 ? `🎯 **Starting from:** Episode ${startEpisode}\n` : '') +
            `📥 **To process:** ${episodesToDownload} episodes\n` +
            `🔁 **Mode:** Download → Upload → Delete (one at a time)\n` +
            `⏳ Starting...`
        );

        let uploaded = 0;
        let failed = 0;

        for (let i = 0; i < filteredEpisodes.length; i++) {
            const ep = filteredEpisodes[i];
            const epStr = String(ep.number);
            const epParts = epStr.split('.');
            const paddedEpNum = epParts[0].padStart(2, '0') + (epParts[1] !== undefined ? '-' + epParts[1] : '');
            const filename = `${folder}/Episode_${paddedEpNum}.mp4`;

            await progressMsg.edit(
                `==== DarrkOS (Loop Mode) ====\n` +
                `📺 **Anime:** ${animeName}\n` +
                `📊 **Progress:** ${uploaded}/${episodesToDownload} uploaded (${failed} failed)\n` +
                `🔍 **Finding CDN for Episode ${ep.number}** (${i + 1}/${episodesToDownload})...`
            );

            try {
                const delay = 300 + Math.random() * 200;
                await new Promise(r => setTimeout(r, delay));

                const downloadSuccess = await tryAllCDNsSmart(
                    ep,
                    filename,
                    animeName,
                    progressMsg,
                    i + 1,
                    episodesToDownload
                );

                if (downloadSuccess) {
                    await progressMsg.edit(
                        `==== DarrkOS (Loop Mode) ====\n` +
                        `📺 **Anime:** ${animeName}\n` +
                        `📊 **Progress:** ${uploaded}/${episodesToDownload} uploaded (${failed} failed)\n` +
                        `📤 **Uploading Episode ${ep.number}** to ${animeChannel}...`
                    );

                    try {
                        await animeChannel.send({
                            content: `**${animeName} - Episode ${ep.number}**`,
                            files: [filename]
                        });
                        uploaded++;
                        console.log(`✅ Loop: Uploaded Episode ${ep.number} (${uploaded}/${episodesToDownload})`);
                    } catch (uploadError) {
                        failed++;
                        console.error(`❌ Loop: Failed to upload Episode ${ep.number}:`, uploadError.message);
                        await channel.send(`❌ **Failed to upload Episode ${ep.number}:** ${uploadError.message}`);
                    }

                    try {
                        if (fs.existsSync(filename)) {
                            fs.unlinkSync(filename);
                            console.log(`🗑️ Loop: Deleted Episode ${ep.number}`);
                        }
                    } catch (cleanupErr) {
                        console.error(`Error deleting file ${filename}:`, cleanupErr);
                    }

                    await progressMsg.edit(
                        `==== DarrkOS (Loop Mode) ====\n` +
                        `📺 **Anime:** ${animeName}\n` +
                        `📊 **Progress:** ${uploaded}/${episodesToDownload} uploaded (${failed} failed)\n` +
                        `✅ **Episode ${ep.number} done** (${i + 1}/${episodesToDownload})`
                    );
                } else {
                    failed++;
                    console.log(`❌ Loop: Download failed for Episode ${ep.number}`);
                    await progressMsg.edit(
                        `==== DarrkOS (Loop Mode) ====\n` +
                        `📺 **Anime:** ${animeName}\n` +
                        `📊 **Progress:** ${uploaded}/${episodesToDownload} uploaded (${failed} failed)\n` +
                        `❌ **Failed Episode ${ep.number}** (All CDNs failed)`
                    );
                }

                await new Promise(r => setTimeout(r, 400));

            } catch (error) {
                failed++;
                console.error(`Error processing episode ${ep.number}:`, error.message);
                try {
                    if (fs.existsSync(filename)) fs.unlinkSync(filename);
                } catch (e) {}

                await progressMsg.edit(
                    `==== DarrkOS (Loop Mode) ====\n` +
                    `📺 **Anime:** ${animeName}\n` +
                    `📊 **Progress:** ${uploaded}/${episodesToDownload} uploaded (${failed} failed)\n` +
                    `❌ **Error Episode ${ep.number}:** ${error.message}`
                );
            }
        }

        try {
            if (fs.existsSync(folder)) {
                const remaining = fs.readdirSync(folder);
                for (const file of remaining) {
                    fs.unlinkSync(path.join(folder, file));
                }
                fs.rmdirSync(folder);
                console.log(`🗑️ Loop: Deleted folder ${folder}`);
            }
        } catch (e) {}

        const categoryName = animeChannel ? (animeChannel.parent ? animeChannel.parent.name : 'Unknown') : 'N/A';
        await channel.send(
            `==== DarrkOS (Loop Mode) ====\n` +
            `🎉 **Complete!**\n` +
            `📺 **Anime:** ${animeName}\n` +
            (startEpisode > 1 ? `🎯 **Started from:** Episode ${startEpisode}\n` : '') +
            `✅ **Uploaded:** ${uploaded}/${episodesToDownload} episodes to ${animeChannel} (${categoryName})\n` +
            `❌ **Failed:** ${failed}`
        );

    } catch (error) {
        console.error('Loop download error:', error);
        if (progressMsg) {
            await progressMsg.edit(`💥 **Loop download failed:** ${error.message}`);
        } else {
            await channel.send(`💥 **Loop download failed:** ${error.message}`);
        }
    }
}

async function downloadAnimeSeries(animeUrl, channel, startEpisode = 1, animeChannel = null) {
    let progressMsg = null;

    try {
        // Send initial message
        progressMsg = await channel.send(`Launching DarrkOS...`);

        // 1. Fetch anime info
        console.log(`🔍 Fetching: ${animeUrl}`);
        const { animeName: parsedName, maxep, dfkey, $, data } = await parseAnimePage(animeUrl);

        let animeName = parsedName;

        // If we somehow ended up with empty name, use fallback
        if (!animeName || animeName.length < 2) {
            animeName = $('h1').first().text().trim() || 'Unknown Anime';
            console.log(`Using fallback name: "${animeName}"`);
        }

        console.log(`Cleaned anime name: "${animeName}"`);
      if (animeName.includes("One Piece") || animeName.includes("Detective Konan")) return;
        // Create safe folder name
        const safeName = animeName
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, "_")
            .replace(/[^a-zA-Z0-9_]/g, '')
            .toLowerCase();

        console.log(`Safe folder name: "${safeName}"`);

        await progressMsg.edit(`📺 **Anime:** ${animeName}\n🔄 Gathering episode information...`);

        // 2. Create folder
        const folder = `./${safeName}`;
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
            console.log(`📁 Created folder: ${folder}`);
        }

        // 3. Find all episode IDs
        console.log(`Fetching episode keys via gate.php (maxep=${maxep})...`);
        let episodes;
        if (dfkey && maxep > 0) {
            episodes = await fetchEpisodeKeysFromGate(dfkey, maxep);
        } else {
            episodes = [];
        }

        if (episodes.length === 0) {
            console.log('Gate crawl returned 0 episodes, trying direct page extraction...');
            episodes = extractEpisodesFromPage($, data);
            if (episodes.length > 0) {
                console.log(`✅ Direct page extraction found ${episodes.length} episodes`);
            }
        }

        if (episodes.length === 0) {
            throw new Error('No episodes found. Could not extract episode keys from the website.');
        }

        // Sort episodes by number (ascending)
        episodes.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));

        console.log(`📊 Found ${episodes.length} episodes`);
        console.log(`📋 Episodes: ${episodes.map(ep => `Ep ${ep.number}`).join(', ')}`);

        // Filter episodes based on startEpisode
        const filteredEpisodes = episodes.filter(ep => {
            const epNum = parseFloat(ep.number);
            return epNum >= startEpisode;
        });

        const totalEpisodes = episodes.length;
        const episodesToDownload = filteredEpisodes.length;

        if (episodesToDownload === 0) {
            throw new Error(`No episodes found starting from episode ${startEpisode}`);
        }

        if (startEpisode > 1) {
            await progressMsg.edit(
                `==== DarrkOS ====\n` +
                `📺 **Anime:** ${animeName}\n` +
                `📊 **Total episodes:** ${totalEpisodes}\n` +
                `🎯 **Starting from:** Episode ${startEpisode}\n` +
                `📥 **To download:** ${episodesToDownload} episodes\n` +
                `📁 **Folder:** ${folder}\n` +
                `⏳ Starting download...`
            );
        } else {
            await progressMsg.edit(
                `==== DarrkOS ====\n` +
                `📺 **Anime:** ${animeName}\n` +
                `📊 **Episodes found:** ${totalEpisodes}\n` +
                `📁 **Folder:** ${folder}\n` +
                `⏳ Starting download...`
            );
        }

        // 4. Download each episode
        let completed = 0;
        let failed = 0;
        let batchNumber = 0;
        let totalUploaded = 0;
        let totalUploadFailed = 0;

        for (let i = 0; i < filteredEpisodes.length; i++) {
            const ep = filteredEpisodes[i];
            const epStr = String(ep.number);
            const epParts = epStr.split('.');
            const paddedEpNum = epParts[0].padStart(2, '0') + (epParts[1] !== undefined ? '-' + epParts[1] : '');
            const filename = `${folder}/Episode_${paddedEpNum}.mp4`;

            // Check if already downloaded
            if (fs.existsSync(filename)) {
                const stats = fs.statSync(filename);
                if (stats.size > 1024 * 1024 * 5) { // > 5MB
                    console.log(`⏭️ Episode ${ep.number} already exists, skipping`);
                    completed++;
                    continue;
                }
            }

            // Update progress message for current episode start
            const batchInfo = batchNumber > 0 ? ` | Batch ${batchNumber + 1}` : '';
            const progressText = startEpisode > 1 ? 
                `🔍 **Finding working CDN for Episode ${ep.number} (${i+1}/${episodesToDownload})...**` :
                `🔍 **Finding working CDN for Episode ${ep.number}...**`;

            await progressMsg.edit(
                `==== DarrkOS ====\n` +
                `📺 **Anime:** ${animeName}${batchInfo}\n` +
                `📊 **Progress:** ${completed}/${episodesToDownload} completed (${failed} failed)\n` +
                `📁 **Folder:** ${folder}\n` +
                `${progressText}`
            );

            try {
                // Add delay before downloading
                const delay = 300 + Math.random() * 200;
                console.log(`⏳ Waiting ${Math.floor(delay)}ms before episode ${ep.number}...`);
                await new Promise(r => setTimeout(r, delay));

                // Try CDNs
                const success = await tryAllCDNsSmart(
                    ep,
                    filename,
                    animeName,
                    progressMsg,
                    i + 1,
                    episodesToDownload
                );

                if (success) {
                    completed++;

                    // Update progress message after success
                    await progressMsg.edit(
                        `==== DarrkOS ====\n` +
                        `📺 **Anime:** ${animeName}${batchInfo}\n` +
                        `📊 **Progress:** ${completed}/${episodesToDownload} completed (${failed} failed)\n` +
                        `📁 **Folder:** ${folder}\n` +
                        `✅ **Downloaded Episode ${ep.number}** (${i+1}/${episodesToDownload})`
                    );

                    console.log(`✅ Downloaded episode ${ep.number} (${completed}/${episodesToDownload})`);

                    // Check 11GB download limit
                    if (animeChannel) {
                        const currentFolderSize = getFolderSize(folder);
                        const currentSizeGB = (currentFolderSize / (1024 * 1024 * 1024)).toFixed(2);
                        console.log(`📊 Current folder size: ${currentSizeGB}GB / 11GB limit`);

                        if (currentFolderSize >= DOWNLOAD_SIZE_LIMIT) {
                            batchNumber++;
                            console.log(`⚠️ 11GB limit reached! Starting batch ${batchNumber} upload...`);

                            await progressMsg.edit(
                                `==== DarrkOS ====\n` +
                                `📺 **Anime:** ${animeName}\n` +
                                `📊 **Progress:** ${completed}/${episodesToDownload} completed (${failed} failed)\n` +
                                `📁 **Folder:** ${folder}\n` +
                                `⚠️ **11GB limit reached! Uploading batch ${batchNumber}...**`
                            );

                            const batchResult = await uploadAndCleanBatch(folder, animeName, animeChannel, channel, batchNumber);
                            totalUploaded += batchResult.sent;
                            totalUploadFailed += batchResult.failed;

                            console.log(`✅ Batch ${batchNumber} done: ${batchResult.sent} uploaded, ${batchResult.failed} failed`);
                        }
                    }
                } else {
                    failed++;

                    // Update progress message after failure
                    await progressMsg.edit(
                        `==== DarrkOS ====\n` +
                        `📺 **Anime:** ${animeName}${batchInfo}\n` +
                        `📊 **Progress:** ${completed}/${episodesToDownload} completed (${failed} failed)\n` +
                        `📁 **Folder:** ${folder}\n` +
                        `❌ **Failed Episode ${ep.number}** (All CDNs failed)`
                    );

                    console.log(`❌ Failed episode ${ep.number}`);
                }

                // Short delay between downloads
                await new Promise(r => setTimeout(r, 400));

            } catch (error) {
                failed++;
                console.error(`Error episode ${ep.number}:`, error.message);

                await progressMsg.edit(
                    `==== DarrkOS ====\n` +
                    `📺 **Anime:** ${animeName}${batchInfo}\n` +
                    `📊 **Progress:** ${completed}/${episodesToDownload} completed (${failed} failed)\n` +
                    `📁 **Folder:** ${folder}\n` +
                    `❌ **Error Episode ${ep.number}:** ${error.message}`
                );
            }
        }

        // Final update for download
        const finalDownloadMessage = startEpisode > 1 ?
            `==== DarrkOS ====\n` +
            `🎉 **Download Complete!**\n` +
            `📺 **Anime:** ${animeName}\n` +
            `🎯 **Started from:** Episode ${startEpisode}\n` +
            `✅ **Successful:** ${completed}/${episodesToDownload}\n` +
            `❌ **Failed:** ${failed}\n` +
            `📁 **Folder:** \`${folder}\`` :
            `==== DarrkOS ====\n` +
            `🎉 **Download Complete!**\n` +
            `📺 **Anime:** ${animeName}\n` +
            `✅ **Successful:** ${completed}/${episodesToDownload}\n` +
            `❌ **Failed:** ${failed}\n` +
            `📁 **Folder:** \`${folder}\``;

        await progressMsg.edit(finalDownloadMessage);

        // 5. Start uploading to the anime channel if it exists
        if (animeChannel) {
            const remainingFiles = fs.existsSync(folder) ? 
                fs.readdirSync(folder).filter(f => f.endsWith('.mp4')) : [];

            if (remainingFiles.length > 0) {
                if (batchNumber > 0) {
                    batchNumber++;
                    await channel.send(`📤 **Uploading final batch ${batchNumber} (${remainingFiles.length} remaining episodes) to ${animeChannel}...**`);
                } else {
                    await channel.send(`📤 **Starting upload to ${animeChannel}...**`);
                }

                const uploadResult = await sendEpisodesToChannelWithCategory(folder, animeName, animeChannel, progressMsg);
                totalUploaded += uploadResult.sent;
                totalUploadFailed += uploadResult.failed;
            }

            const grandTotalUploaded = totalUploaded;
            const grandTotalFailed = totalUploadFailed;
            const categoryName = animeChannel.parent ? animeChannel.parent.name : 'Unknown Category';
            const batchSummary = batchNumber > 0 ? `\n📦 **Batches used:** ${batchNumber} (11GB limit)` : '';

            if (grandTotalFailed === 0 && grandTotalUploaded > 0) {
                try {
                    if (fs.existsSync(folder)) {
                        const files = fs.readdirSync(folder);
                        let deletedFiles = 0;
                        for (const file of files) {
                            const filePath = path.join(folder, file);
                            fs.unlinkSync(filePath);
                            deletedFiles++;
                        }
                        fs.rmdirSync(folder);
                    }

                    await channel.send(
                        `✅ **Process Complete!**\n` +
                        `📥 **Downloaded:** ${completed}/${episodesToDownload} episodes\n` +
                        `📤 **Uploaded:** ${grandTotalUploaded} episodes to ${animeChannel} (Category: ${categoryName})${batchSummary}\n` +
                        `🗑️ **Auto-deleted:** Folder \`${folder}\``
                    );
                    console.log(`🗑️ Auto-deleted folder: ${folder}`);
                } catch (deleteError) {
                    console.error('Error auto-deleting folder:', deleteError);
                    await channel.send(
                        `✅ **Process Complete!**\n` +
                        `📥 **Downloaded:** ${completed}/${episodesToDownload} episodes\n` +
                        `📤 **Uploaded:** ${grandTotalUploaded} episodes to ${animeChannel} (Category: ${categoryName})${batchSummary}\n` +
                        `⚠️ **Note:** Failed to auto-delete folder \`${folder}\`: ${deleteError.message}`
                    );
                }
            } else if (grandTotalUploaded > 0) {
                await channel.send(
                    `⚠️ **Process Complete with Issues**\n` +
                    `📥 **Downloaded:** ${completed}/${episodesToDownload} episodes\n` +
                    `📤 **Uploaded:** ${grandTotalUploaded} episodes to ${animeChannel} (Category: ${categoryName})${batchSummary}\n` +
                    `❌ **Failed uploads:** ${grandTotalFailed} episodes\n` +
                    `📁 **Folder kept for retry:** \`${folder}\``
                );
            }
        }

    } catch (error) {
        console.error('Download error:', error);
        if (progressMsg) {
            await progressMsg.edit(`💥 **Download failed:** ${error.message}`);
        } else {
            await channel.send(`💥 **Download failed:** ${error.message}`);
        }
    }
}

async function tryAllCDNsSmart(episode, filename, animeName, progressMsg, index, total) {
    console.log(`🔍 Episode ${episode.number} (${index}/${total}) - Working CDN: ${currentWorkingCDN || 'None'}`);

    // If we have a working CDN, try it first
    if (currentWorkingCDN && cdnFailCount < 3) {
        console.log(`🎯 Trying cached CDN: ${currentWorkingCDN}`);
        const success = await trySpecificCDN(currentWorkingCDN, episode, filename, animeName, progressMsg, index, total);
        if (success) {
            cdnFailCount = 0; // Reset fail count on success
            if (cdnSuccessHistory[currentWorkingCDN]) {
                cdnSuccessHistory[currentWorkingCDN]++;
            } else {
                cdnSuccessHistory[currentWorkingCDN] = 1;
            }
            return true;
        } else {
            cdnFailCount++;
            console.log(`⚠️ Cached CDN ${currentWorkingCDN} failed (${cdnFailCount}/3)`);

            // If failed 3 times, mark as bad and find new CDN
            if (cdnFailCount >= 3) {
                console.log(`🚫 CDN ${currentWorkingCDN} marked as temporarily unavailable`);
                currentWorkingCDN = null;
                cdnFailCount = 0;
            }
        }
    }

    // If no working CDN or cached CDN failed, search for new one
    console.log(`🔍 Searching for new working CDN...`);

    // Sort CDNs by success history (most successful first)
    const sortedCDNs = [...CDN_DOMAINS].sort((a, b) => {
        const scoreA = cdnSuccessHistory[a] || 0;
        const scoreB = cdnSuccessHistory[b] || 0;
        return scoreB - scoreA;
    });

    for (const domain of sortedCDNs) {
        console.log(`🔍 Testing CDN: ${domain} (Success: ${cdnSuccessHistory[domain] || 0})`);

        const success = await trySpecificCDN(domain, episode, filename, animeName, progressMsg, index, total, true);
        if (success) {
            // Found new working CDN
            currentWorkingCDN = domain;
            cdnFailCount = 0;
            lastCdnSwitchTime = Date.now();

            if (cdnSuccessHistory[domain]) {
                cdnSuccessHistory[domain]++;
            } else {
                cdnSuccessHistory[domain] = 1;
            }

            console.log(`🎯 New working CDN set: ${domain} (Total successes: ${cdnSuccessHistory[domain]})`);
            return true;
        }

        // Short delay between CDN tests
        await new Promise(r => setTimeout(r, 700));
    }

    console.log(`❌ All CDNs failed for episode ${episode.number}`);
    return false;
}

async function trySpecificCDN(domain, episode, filename, animeName, progressMsg, index, total, isSearching = false) {
    // FIXED URL PATTERN: https://<CDN>.animeheaven.me/video.mp4?<ID>&d
    const mp4Url = `https://${domain}.animeheaven.me/video.mp4?${episode.id}&d`;

    let response = null;
    let writer = null;
    let downloadComplete = false;

    try {
        console.log(`🔗 Trying URL: ${mp4Url}`);

        // Add random user agent
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];

        const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

        // Quick HEAD check with timeout
        try {
            const headResponse = await axios.head(mp4Url, {
                headers: { 
                    'User-Agent': userAgent,
                    'Referer': 'https://animeheaven.me/'
                },
                timeout: 5000,
                validateStatus: () => true
            });

            if (headResponse.status !== 200) {
                console.log(`❌ ${domain} HTTP ${headResponse.status} - skipping`);
                return false;
            }
        } catch (headError) {
            console.log(`❌ ${domain} HEAD request failed: ${headError.message} - skipping`);
            return false;
        }

        // ✅ Working CDN found
        if (progressMsg) {
            const statusText = isSearching ? `🔍 Found new CDN: ${domain}` : `📥 Downloading via CDN: ${domain}`;
            await progressMsg.edit(
                `==== DarrkOS ====\n` +
                `📺 **Anime:** ${animeName}\n` +
                `📊 **Progress:** ${index - 1}/${total} completed\n` +
                `${statusText}\n` +
                `📥 **Downloading Episode ${episode.number}** (${index}/${total})`
            );
        }

        console.log(`✅ ${domain} seems available, starting download...`);

        // Add small delay before actual download
        await new Promise(r => setTimeout(r, 400));

        response = await axios({
            url: mp4Url,
            method: 'GET',
            responseType: 'stream',
            headers: { 
                'User-Agent': userAgent,
                'Referer': 'https://animeheaven.me/',
                'Accept': '*/*',
                'Accept-Encoding': 'identity'
            },
            timeout: 60000, // 60 second timeout
            validateStatus: (status) => status >= 200 && status < 400
        });

        writer = fs.createWriteStream(filename);
        let downloadedBytes = 0;
        let lastLogTime = Date.now();

        // Show download progress in console
        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            if (now - lastLogTime > 5000) { // Log every 5 seconds
                console.log(`📥 Episode ${episode.number}: ${(downloadedBytes / (1024 * 1024)).toFixed(2)}MB via ${domain}`);
                lastLogTime = now;
            }
        });

        response.data.pipe(writer);

        // Set up error handlers BEFORE starting the pipe
        await new Promise((resolve, reject) => {
            let hasResolved = false;
            let hasRejected = false;

            const cleanup = () => {
                if (response?.data) {
                    response.data.removeAllListeners();
                }
                if (writer) {
                    writer.removeAllListeners();
                }
            };

            const resolveOnce = (value) => {
                if (!hasResolved && !hasRejected) {
                    hasResolved = true;
                    downloadComplete = true;
                    cleanup();
                    resolve(value);
                }
            };

            const rejectOnce = (error) => {
                if (!hasResolved && !hasRejected) {
                    hasRejected = true;
                    cleanup();
                    reject(error);
                }
            };

            writer.on('finish', () => resolveOnce(true));
            writer.on('error', rejectOnce);
            response.data.on('error', rejectOnce);

            // Set a timeout to prevent hanging
            setTimeout(() => {
                if (!hasResolved && !hasRejected) {
                    console.log(`⏰ Download timeout for episode ${episode.number} via ${domain}`);
                    rejectOnce(new Error('Download timeout'));
                }
            }, 180000); // 3 minute timeout
        });

        const fileSizeMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
        console.log(`✅ Episode ${episode.number} complete: ${fileSizeMB}MB via ${domain} CDN`);

        // Verify file is valid (not error page)
        if (fs.existsSync(filename)) {
            const stats = fs.statSync(filename);
            if (stats.size < 1024 * 1024) { // Less than 1MB (likely error page)
                console.log(`⚠️ File too small (${fileSizeMB}MB), likely error page`);
                fs.unlinkSync(filename);
                return false;
            }
        }

        return true;

    } catch (error) {
        console.log(`❌ ${domain} CDN failed for episode ${episode.number}: ${error.code || error.message}`);

        // Clean up any dangling resources
        try {
            if (response?.data && !downloadComplete) {
                response.data.destroy();
            }
            if (writer && !downloadComplete) {
                writer.destroy();
                writer.end();
            }
        } catch (cleanupError) {
            // Ignore cleanup errors
        }

        if (fs.existsSync(filename)) {
            try {
                fs.unlinkSync(filename);
            } catch (unlinkError) {
                // Ignore unlink errors
            }
        }

        return false;
    }
}

// Helper function to delete a directory and all its contents
function deleteDirectory(directoryName) {
    const folderPath = `./${directoryName}`;

    if (!fs.existsSync(folderPath)) {
        return { success: false, message: `Folder "${directoryName}" not found!` };
    }

    try {
        // Delete all files in the directory
        const files = fs.readdirSync(folderPath);
        let deletedFiles = 0;

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            fs.unlinkSync(filePath);
            deletedFiles++;
        }

        // Delete the directory itself
        fs.rmdirSync(folderPath);

        return { 
            success: true, 
            message: `✅ Deleted folder "${directoryName}" and ${deletedFiles} episode files.`,
            deletedFiles: deletedFiles
        };

    } catch (error) {
        return { 
            success: false, 
            message: `❌ Error deleting folder "${directoryName}": ${error.message}`
        };
    }
}

// Helper function to list directories (for debugging)
function listDirectories() {
    try {
        const items = fs.readdirSync('.', { withFileTypes: true });
        return items
            .filter(item => item.isDirectory())
            .map(dir => dir.name)
            .filter(name => !name.startsWith('.') && name !== 'node_modules');
    } catch (error) {
        console.error('Error listing directories:', error);
        return [];
    }
}

client.on('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    // Reset CDN state on startup
    currentWorkingCDN = null;
    cdnFailCount = 0;
    lastCdnSwitchTime = Date.now();
    Object.keys(cdnSuccessHistory).forEach(key => delete cdnSuccessHistory[key]);

    const startupChannelId = '1492627296568213636';
    const channel = client.channels.cache.get(startupChannelId);
    if (channel) {
        channel.send('!downloadlatest').catch(err => {
            console.error('Failed to send startup message:', err);
        });
    } else {
        console.warn('⚠️ Could not find channel ' + startupChannelId + ' to send startup message.');
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.id !== client.user.id) return;

if (message.content === "!automate") {
 setInterval(() => {
 message.channel.send("!downloadlatest")
}, 1000 * 60 * 30)
}
if (message.content.includes("www.instagram.com") || message.content.includes("youtube.com/watch") || message.content.includes("youtu.be/")) {
    const urlMatch = message.content.match(/https?:\/\/[^\s]+/);

    if (urlMatch && urlMatch[0]) {
        const videoUrl = urlMatch[0];

        if (videoUrl.includes("instagram.com")) {
            console.log("Instagram URL found:", videoUrl);

            try {
                // Download the Instagram video
                await downloadIG(videoUrl, "ig_vid.mp4");

                // Check if file was downloaded successfully
                if (fs.existsSync("ig_vid.mp4")) {
                    // Wait 5 seconds and send the video
                    setTimeout(async () => {
                        await message.channel.send({ 
                            content: "`bro sent this`",
                            files: ["ig_vid.mp4"] 
                        });

                        // Clean up the file after sending
                        setTimeout(() => {
                            try {
                                if (fs.existsSync("ig_vid.mp4")) {
                                    fs.unlinkSync("ig_vid.mp4");
                                    console.log("Cleaned up ig_vid.mp4");
                                }
                            } catch (cleanupError) {
                                console.error("Error cleaning up file:", cleanupError);
                            }
                        }, 3000);

                    }, 3000);
                } else {
                    await message.channel.send("❌ Failed to download Instagram video");
                }
            } catch (error) {
                console.error("Instagram download error:", error);
                await message.channel.send(`❌ Error downloading Instagram video: ${error.message}`);
            }
        } 
      else if (videoUrl.includes("youtube.com/watch") || videoUrl.includes("youtu.be/")) {
    console.log("YouTube URL found:", videoUrl);

    try {
        // Download the YouTube video using ab-downloader
        const data = await youtube(videoUrl);
        console.log('✅ YouTube video downloaded!');

        // The data contains an mp4 property with the direct video URL
        if (data && data.mp4) {
            console.log('Downloading from URL:', data.mp4);

            // Download the video from the mp4 URL
            const response = await axios({
                method: 'GET',
                url: data.mp4,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream("yt_vid.mp4");
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // Also log the video info
            console.log(`📹 Title: ${data.title}`);
            console.log(`👤 Author: ${data.author}`);
        }
        else {
            console.log('Unexpected data structure:', JSON.stringify(data, null, 2));
            throw new Error('Could not find mp4 URL in response');
        }

        // Check if file was downloaded successfully
        if (fs.existsSync("yt_vid.mp4")) {
            // Get file size for logging
            const stats = fs.statSync("yt_vid.mp4");
            const fileSizeInMB = stats.size / (1024 * 1024);
            console.log(`📊 File size: ${fileSizeInMB.toFixed(2)} MB`);

            // Wait 3 seconds and send the video
            setTimeout(async () => {
                await message.channel.send({ 
                    content: `\`${data.title || 'bro sent this YouTube video'}\``,
                    files: ["yt_vid.mp4"] 
                });

                // Clean up the file after sending
                setTimeout(() => {
                    try {
                        if (fs.existsSync("yt_vid.mp4")) {
                            fs.unlinkSync("yt_vid.mp4");
                            console.log("Cleaned up yt_vid.mp4");
                        }
                    } catch (cleanupError) {
                        console.error("Error cleaning up file:", cleanupError);
                    }
                }, 3000);

            }, 3000);
        } else {
            await message.channel.send("❌ Failed to download YouTube video");
        }
    } catch (error) {
        console.error("YouTube download error:", error);
        await message.channel.send(`❌ Error downloading YouTube video: ${error.message}`);
    }
}
}}

    if (message.content.startsWith('!find')) {
        const args = message.content.split(' ').slice(1);

        try {
            // Check if user provided search term
            if (!args.length) {
                return message.reply('Please provide a channel name to search for!\nUsage: `!find <channel-name>`');
            }

            const searchTerm = args.join(' ').toLowerCase();

            // Get all channels in the guild
            const channels = message.guild.channels.cache;

            // Filter channels that contain the search term (case-insensitive)
            const matchingChannels = channels.filter(channel => 
                channel.name.toLowerCase().includes(searchTerm)
            );

            // If no channels found
            if (matchingChannels.size === 0) {
                return message.reply(`No channels found containing: "${searchTerm}"`);
            }

            // Format the response
            let response = `Found ${matchingChannels.size} channel(s) containing "${searchTerm}":\n\n`;

            matchingChannels.forEach(channel => {
                response += `• ${channel} - \`#${channel.name}\`\n`;
            });

            // If response is too long, send multiple messages
            if (response.length > 2000) {
                // Send first 2000 characters
                await message.reply(response.slice(0, 1997) + '...');

                // For additional content, you could implement pagination here
                const remaining = response.slice(1997);
                if (remaining.length > 0) {
                    await message.channel.send(`...${remaining.slice(0, 1997)}`);
                }
            } else {
                await message.reply(response);
            }

        } catch (error) {
            console.error('Error executing find command:', error);
            message.reply('There was an error trying to find channels!');
        }
    }

    // !info command
    if (message.content.startsWith('!info')) {
        const args = message.content.split(' ').slice(1);

        if (args.length === 0) {
            await message.channel.send('❌ Please provide an anime name: `!info <anime_name>`');
            return;
        }

        const animeName = args.join(' ');
        const infoMsg = await message.channel.send(`🔍 **Searching for "${animeName}"...**`);

        try {
            // Search for the anime
            const foundUrl = await searchAnime(animeName);
            if (!foundUrl) {
                await infoMsg.edit(`❌ **No anime found for "${animeName}"**`);
                return;
            }

            // Fetch detailed info
            const animeInfo = await fetchAnimeInfo(foundUrl);
            if (!animeInfo) {
                await infoMsg.edit(`❌ **Failed to fetch info for "${animeName}"**`);
                return;
            }

            // Format the info message
            const infoText = 
                `Name: ${animeInfo.name}\n` +
                `Synopsis: ${animeInfo.synopsis}\n\n` +
                `Genres: ${animeInfo.genres}\n` +
                `Synonyms: ${animeInfo.synonyms}\n` +
                `ImageURL: ${animeInfo.imageUrl}`;

            await infoMsg.edit(infoText);

        } catch (error) {
            console.error('Info command error:', error);
            await infoMsg.edit(`❌ **Info fetch failed:** ${error.message}`);
        }
    }

if (message.content === '!downloadlatest') {
    const loadingMsg = await message.channel.send('🔍 **Fetching latest anime and checking for updates...**');

    try {
        const latestAnime = await fetchLatestAnime();
        const top5Anime = latestAnime.slice(0, 5);

        if (top5Anime.length === 0) {
            await loadingMsg.edit('❌ **Failed to fetch latest anime**');
            return;
        }

        let progressText = '📺 **Checking Latest 5 Anime (All Episodes):**\n\n';
        const statusMap = {};
        for (let i = 0; i < top5Anime.length; i++) {
            const anime = top5Anime[i];
            statusMap[i] = 'Pending...';
            progressText += `**${i + 1}.** ${anime.englishTitle}\n`;
            progressText += `   📊 Latest: Ep ${anime.episodeCount}\n`;
            progressText += `   ⏳ Status: Pending...\n\n`;
        }
        await loadingMsg.edit(progressText);

        function updateProgress(index, newStatus) {
            statusMap[index] = newStatus;
            let text = '📺 **Checking Latest 5 Anime (All Episodes):**\n\n';
            for (let i = 0; i < top5Anime.length; i++) {
                text += `**${i + 1}.** ${top5Anime[i].englishTitle}\n`;
                text += `   📊 Latest: Ep ${top5Anime[i].episodeCount}\n`;
                text += `   ${statusMap[i]}\n\n`;
            }
            return text;
        }

        const results = [];

        for (let i = 0; i < top5Anime.length; i++) {
            const anime = top5Anime[i];

            progressText = updateProgress(i, '⏳ Processing...');
            await loadingMsg.edit(progressText);

            try {
                const animeInfo = await fetchAnimeInfo(anime.url);

                const attemptedCategories = [];
                const channelResult = await findOrCreateAnimeChannelWithFallback(
                    message.guild,
                    anime.englishTitle,
                    animeInfo,
                    attemptedCategories
                );

                if (!channelResult.success || !channelResult.channel) {
                    results.push({
                        title: anime.englishTitle,
                        status: `❌ Failed to create/find channel in any category`
                    });
                    progressText = updateProgress(i, '❌ Channel creation failed');
                    await loadingMsg.edit(progressText);
                    continue;
                }

                const animeChannel = channelResult.channel;
                const usedCategory = channelResult.categoryName || 'Unknown';

                progressText = updateProgress(i, `⏳ Scanning channel for existing episodes (${usedCategory})...`);
                await loadingMsg.edit(progressText);

                const allEpisodes = await getAllEpisodesFromPage(anime.url);
                if (allEpisodes.length === 0) {
                    results.push({
                        title: anime.englishTitle,
                        status: `⚠️ No episodes found on page (${usedCategory})`,
                        channel: animeChannel
                    });
                    progressText = updateProgress(i, `⚠️ No episodes found on page`);
                    await loadingMsg.edit(progressText);
                    continue;
                }

                const postedEpisodes = await getAllPostedEpisodes(animeChannel);
                const missingEpisodes = allEpisodes.filter(ep => !postedEpisodes.has(ep.number));

                if (missingEpisodes.length === 0) {
                    results.push({
                        title: anime.englishTitle,
                        status: `✅ All ${allEpisodes.length} episodes already in ${usedCategory}`,
                        channel: animeChannel
                    });
                    progressText = updateProgress(i, `✅ All ${allEpisodes.length} eps present (${usedCategory})`);
                    await loadingMsg.edit(progressText);
                    continue;
                }

                progressText = updateProgress(i, `📥 ${missingEpisodes.length}/${allEpisodes.length} eps missing - downloading (${usedCategory})...`);
                await loadingMsg.edit(progressText);

                const safeName = anime.englishTitle
                    .replace(/[<>:"/\\|?*]/g, '_')
                    .replace(/\s+/g, "_")
                    .replace(/[^a-zA-Z0-9_]/g, '')
                    .toLowerCase();

                const folder = `./${safeName}`;
                if (!fs.existsSync(folder)) {
                    fs.mkdirSync(folder, { recursive: true });
                }

                let uploaded = 0;
                let failed = 0;

                for (let j = 0; j < missingEpisodes.length; j++) {
                    const ep = missingEpisodes[j];

                    progressText = updateProgress(i, `📥 Downloading Ep ${ep.number} (${j + 1}/${missingEpisodes.length}) for ${usedCategory}...`);
                    await loadingMsg.edit(progressText);

                    const epStr = String(ep.number);
                    const epParts = epStr.split('.');
                    const paddedEpNum = epParts[0].padStart(2, '0') + (epParts[1] !== undefined ? '-' + epParts[1] : '');
                    const filename = `${folder}/Episode_${paddedEpNum}.mp4`;

                    try {
                        const downloadSuccess = await tryAllCDNsSmart(
                            { id: ep.id, number: String(ep.number) },
                            filename,
                            anime.englishTitle,
                            loadingMsg,
                            j + 1,
                            missingEpisodes.length
                        );

                        if (downloadSuccess) {
                            await animeChannel.send({
                                content: `**${anime.englishTitle} Anime | - Episode ${ep.number}**`,
                                files: [filename]
                            });

                            try {
                                if (fs.existsSync(filename)) {
                                    fs.unlinkSync(filename);
                                }
                            } catch (cleanupErr) {
                                console.error(`Error deleting file ${filename}:`, cleanupErr);
                            }

                            uploaded++;
                            progressText = updateProgress(i, `📥 Uploaded Ep ${ep.number} (${uploaded}/${missingEpisodes.length} done) for ${usedCategory}...`);
                            await loadingMsg.edit(progressText);
                        } else {
                            failed++;
                            console.error(`Download failed for ${anime.englishTitle} Ep ${ep.number}`);
                        }
                    } catch (epError) {
                        failed++;
                        console.error(`Error downloading/uploading ${anime.englishTitle} Ep ${ep.number}:`, epError);
                        try {
                            if (fs.existsSync(filename)) fs.unlinkSync(filename);
                        } catch (e) {}
                    }
                }

                try {
                    if (fs.existsSync(folder)) {
                        const remaining = fs.readdirSync(folder);
                        for (const file of remaining) {
                            fs.unlinkSync(path.join(folder, file));
                        }
                        fs.rmdirSync(folder);
                        console.log(`🗑️ Deleted folder: ${folder}`);
                    }
                } catch (cleanupError) {
                    console.error('Error during folder cleanup:', cleanupError);
                }

                const statusMsg = failed === 0
                    ? `✅ Uploaded ${uploaded}/${missingEpisodes.length} missing eps to ${usedCategory}`
                    : `⚠️ Uploaded ${uploaded}, failed ${failed} of ${missingEpisodes.length} eps (${usedCategory})`;

                results.push({
                    title: anime.englishTitle,
                    status: statusMsg,
                    channel: animeChannel
                });
                progressText = updateProgress(i, statusMsg);
                await loadingMsg.edit(progressText);

            } catch (error) {
                console.error(`Error processing ${anime.englishTitle}:`, error);
                results.push({
                    title: anime.englishTitle,
                    status: `❌ Error: ${error.message}`
                });
                progressText = updateProgress(i, `❌ Error - ${error.message.substring(0, 30)}`);
                await loadingMsg.edit(progressText);
            }
        }

        let summary = '📊 **Download Latest Summary:**\n\n';
        results.forEach((result, index) => {
            summary += `**${index + 1}.** ${result.title}\n`;
            summary += `   ${result.status}`;
            if (result.channel) {
                summary += ` in ${result.channel}`;
            }
            summary += '\n\n';
        });
        summary += `🕐 *Checked at: ${new Date().toLocaleString()}*`;
        await message.channel.send(summary);

    } catch (error) {
        console.error('Download latest command error:', error);
        await loadingMsg.edit(`❌ **Error in !downloadlatest:** ${error.message}`);
    }
}

    // !loopdn command
    if (message.content.startsWith('!loopdn')) {
        console.log(`Loop download command: ${message.content}`);
        const args = message.content.split(' ').slice(1);

        if (args.length === 0) {
            return;
        }

        const input = args[0];
        let startEpisode = 1;

        const hasSeasonKeyword = args.some(word => 
            word.toLowerCase().includes('season') || 
            word.toLowerCase().includes('s2') ||
            word.toLowerCase().includes('s1') ||
            word.toLowerCase().includes('part')
        );

        if (!hasSeasonKeyword && args.length > 1 && !isNaN(parseInt(args[args.length - 1]))) {
            startEpisode = parseInt(args[args.length - 1]);
            args.pop();
        }

        let animeUrl = input;
        let animeChannel = null;

        if (!input.startsWith('http')) {
            const animeName = args.join(' ');
            const searchMsg = await message.channel.send(`🔍 **Searching for "${animeName}"...**`);

            try {
                const foundUrl = await searchAnime(animeName);
                if (!foundUrl) {
                    await searchMsg.edit(`❌ **No anime found for "${animeName}"**`);
                    return;
                }

                animeUrl = foundUrl;
                const animeInfo = await fetchAnimeInfo(animeUrl);

                if (animeInfo) {
                    try {
                        const infoChannel = await client.channels.fetch(ANIME_INFO_CHANNEL_ID);
                        if (infoChannel) {
                            const infoText = 
                                `Name: ${animeInfo.name}\n` +
                                `Synopsis: ${animeInfo.synopsis}\n\n` +
                                `Genres: ${animeInfo.genres}\n` +
                                `Synonyms: ${animeInfo.synonyms}\n` +
                                `ImageURL: ${animeInfo.imageUrl}`;
                            await infoChannel.send(infoText);
                        }
                    } catch (infoError) {
                        console.error('Error sending anime info:', infoError);
                    }

                    const channelResult = await createAnimeChannelWithFallback(animeInfo.name, message.guild);
                    if (channelResult.success && channelResult.channel) {
                        animeChannel = channelResult.channel;
                        await searchMsg.edit(`✅ **Found anime!** Created channel ${animeChannel} in category ${channelResult.categoryName}\n🔁 Starting loop download...`);
                    } else {
                        await searchMsg.edit(`✅ **Found anime!** But failed to create channel. Cannot proceed with loop download.`);
                        return;
                    }
                } else {
                    await searchMsg.edit(`✅ **Found anime!** But failed to get info. Cannot create channel.`);
                    return;
                }

                await new Promise(r => setTimeout(r, 1000));

            } catch (error) {
                await searchMsg.edit(`❌ **Search failed:** ${error.message}`);
                return;
            }
        } else {
            try {
                const animeInfo = await fetchAnimeInfo(animeUrl);
                if (animeInfo) {
                    const infoChannel = await client.channels.fetch(ANIME_INFO_CHANNEL_ID);
                    if (infoChannel) {
                        const infoText = 
                            `Name: ${animeInfo.name}\n` +
                            `Synopsis: ${animeInfo.synopsis}\n\n` +
                            `Genres: ${animeInfo.genres}\n` +
                            `Synonyms: ${animeInfo.synonyms}\n` +
                            `ImageURL: ${animeInfo.imageUrl}`;
                        await infoChannel.send(infoText);
                    }

                    const channelResult = await createAnimeChannelWithFallback(animeInfo.name, message.guild);
                    if (channelResult.success && channelResult.channel) {
                        animeChannel = channelResult.channel;
                        await message.channel.send(`✅ Created channel ${animeChannel} in category ${channelResult.categoryName}\n🔁 Starting loop download...`);
                    } else {
                        await message.channel.send(`❌ **Failed to create channel.** Cannot proceed with loop download.`);
                        return;
                    }
                } else {
                    await message.channel.send(`❌ **Failed to get anime info.** Cannot create channel.`);
                    return;
                }
            } catch (infoError) {
                console.error('Error in loopdn:', infoError);
                await message.channel.send(`❌ **Error:** ${infoError.message}`);
                return;
            }
        }

        currentWorkingCDN = null;
        cdnFailCount = 0;
        lastCdnSwitchTime = Date.now();
        Object.keys(cdnSuccessHistory).forEach(key => delete cdnSuccessHistory[key]);

        await loopDownloadAnimeSeries(animeUrl, message.channel, startEpisode, animeChannel);
    }

    // !download command
    if (message.content.startsWith('!download')) {
        console.log(`Download command: ${message.content}`);
        const args = message.content.split(' ').slice(1);

        if (args.length === 0) {
            return;
        }

        const input = args[0];
        let startEpisode = 1;

        // Check if episode number is provided (optional, at the end)
        const hasSeasonKeyword = args.some(word => 
            word.toLowerCase().includes('season') || 
            word.toLowerCase().includes('s2') ||
            word.toLowerCase().includes('s1') ||
            word.toLowerCase().includes('part')
        );

        if (!hasSeasonKeyword && args.length > 1 && !isNaN(parseInt(args[args.length - 1]))) {
            startEpisode = parseInt(args[args.length - 1]);
            // Remove episode number from input
            args.pop();
        }

        let animeUrl = input;
        let animeChannel = null;

        // If input is not a URL (doesn't start with http), treat it as anime name and search for it
        if (!input.startsWith('http')) {
            const animeName = args.join(' ');
            const searchMsg = await message.channel.send(`🔍 **Searching for "${animeName}"...**`);

            try {
                const foundUrl = await searchAnime(animeName);
                if (!foundUrl) {
                    await searchMsg.edit(`❌ **No anime found for "${animeName}"**`);
                    return;
                }

                animeUrl = foundUrl;

                // Fetch anime info
                const animeInfo = await fetchAnimeInfo(animeUrl);

                if (animeInfo) {
                    // Send anime info to the dedicated channel
                    try {
                        const infoChannel = await client.channels.fetch(ANIME_INFO_CHANNEL_ID);
                        if (infoChannel) {
                            const infoText = 
                                `Name: ${animeInfo.name}\n` +
                                `Synopsis: ${animeInfo.synopsis}\n\n` +
                                `Genres: ${animeInfo.genres}\n` +
                                `Synonyms: ${animeInfo.synonyms}\n` +
                                `ImageURL: ${animeInfo.imageUrl}`;

                            await infoChannel.send(infoText);
                            console.log(`✅ Sent anime info to channel ${ANIME_INFO_CHANNEL_ID}`);
                        }
                    } catch (infoError) {
                        console.error('Error sending anime info:', infoError);
                    }

                    // Create a new channel for this anime with category fallback
                    const channelResult = await createAnimeChannelWithFallback(animeInfo.name, message.guild);

                    if (channelResult.success && channelResult.channel) {
                        animeChannel = channelResult.channel;
                        await searchMsg.edit(`✅ **Found anime!** Created channel ${animeChannel} in category ${channelResult.categoryName}\n📥 Starting download...`);
                    } else {
                        await searchMsg.edit(`✅ **Found anime!** But failed to create channel in any category. Starting download in current channel.`);
                    }
                } else {
                    await searchMsg.edit(`✅ **Found anime!** Starting download from: ${animeUrl}`);
                }

                // Small delay before starting download
                await new Promise(r => setTimeout(r, 1000));

            } catch (error) {
                await searchMsg.edit(`❌ **Search failed:** ${error.message}`);
                return;
            }
        } else {
            // If URL provided directly, still try to fetch and send info
            try {
                const animeInfo = await fetchAnimeInfo(animeUrl);
                if (animeInfo) {
                    // Send to info channel
                    const infoChannel = await client.channels.fetch(ANIME_INFO_CHANNEL_ID);
                    if (infoChannel) {
                        const infoText = 
                            `Name: ${animeInfo.name}\n` +
                            `Synopsis: ${animeInfo.synopsis}\n\n` +
                            `Genres: ${animeInfo.genres}\n` +
                            `Synonyms: ${animeInfo.synonyms}\n` +
                            `ImageURL: ${animeInfo.imageUrl}`;

                        await infoChannel.send(infoText);
                        console.log(`✅ Sent anime info to channel ${ANIME_INFO_CHANNEL_ID}`);
                    }

                    // Create a new channel for this anime with category fallback
                    const channelResult = await createAnimeChannelWithFallback(animeInfo.name, message.guild);

                    if (channelResult.success && channelResult.channel) {
                        animeChannel = channelResult.channel;
                        await message.channel.send(`✅ Created channel ${animeChannel} in category ${channelResult.categoryName}\n📥 Starting download...`);
                    }
                }
            } catch (infoError) {
                console.error('Error sending anime info:', infoError);
            }
        }

        // Reset CDN state for new download session
        currentWorkingCDN = null;
        cdnFailCount = 0;
        lastCdnSwitchTime = Date.now();
        Object.keys(cdnSuccessHistory).forEach(key => delete cdnSuccessHistory[key]);

        // Start download with the anime channel for auto-upload after completion
        await downloadAnimeSeries(animeUrl, message.channel, startEpisode, animeChannel);
    }

    // !send command
    if (message.content.startsWith('!send')) {
        const args = message.content.split(' ').slice(1);

        if (args.length < 1) {
            await message.channel.send('❌ Usage: `!send <directory_name>`');
            return;
        }

        let directoryName = args[0];

        // Remove any quotes and clean up
        directoryName = directoryName.replace(/['"]/g, '')
                                   .replace(/\s+/g, '_')
                                   .toLowerCase();

        const folderPath = `./${directoryName}`;

        // Check if folder exists
        if (!fs.existsSync(folderPath)) {
            // List available directories
            const dirs = listDirectories();
            if (dirs.length === 0) {
                await message.channel.send(`❌ Folder "${directoryName}" not found! No anime folders exist.`);
            } else {
                await message.channel.send(`❌ Folder "${directoryName}" not found!\n📁 Available folders: ${dirs.join(', ')}`);
            }
            return;
        }

        const statusMsg = await message.channel.send(`📁 Checking "${directoryName}" folder...`);

        try {
            // Get all MP4 files in the folder
            const files = fs.readdirSync(folderPath)
                .filter(file => file.endsWith('.mp4'))
                .sort((a, b) => {
                    // Sort by episode number
                    const epNumA = parseFloat((a.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '0').replace('-', '.'));
                    const epNumB = parseFloat((b.match(/Episode_(\d+(?:-\d+)?)/)?.[1] || '0').replace('-', '.'));
                    return epNumA - epNumB;
                });

            if (files.length === 0) {
                await statusMsg.edit(`❌ No MP4 files found in "${directoryName}" folder!`);
                return;
            }

            // Create or get anime channel with category fallback
            const animeName = directoryName.replace(/_/g, ' ');
            let animeChannel = message.channel;

            // Try to find existing channel or create new one with fallback
            const channelResult = await createAnimeChannelWithFallback(animeName, message.guild);

            if (channelResult.success && channelResult.channel) {
                animeChannel = channelResult.channel;
                await statusMsg.edit(`📁 Found/Created channel ${animeChannel} in category ${channelResult.categoryName}\n📤 Starting upload...`);
            } else {
                await statusMsg.edit(`📁 Using current channel (failed to create dedicated channel)\n📤 Starting upload...`);
            }

            // Send all episodes to the channel
            await sendEpisodesToChannelWithCategory(folderPath, animeName, animeChannel, statusMsg);

        } catch (error) {
            console.error('Error in !send command:', error);
            await statusMsg.edit(`❌ Error: ${error.message}`);
        }
    }

if (message.content === '!latest') {
    const loadingMsg = await message.channel.send('🔍 **Fetching latest anime from animeheaven.me...**');

    try {
        const latestAnime = await fetchLatestAnime();

        if (latestAnime.length === 0) {
            await loadingMsg.edit('❌ **No latest anime found or failed to fetch data**');
            return;
        }

        // Create formatted message
        let response = '📺 **Latest 10 Anime on AnimeHeaven**\n\n';

        latestAnime.forEach((anime, index) => {
            // Format episode count with emoji
            const epDisplay = anime.episodeCount !== '?' ? `📊 Ep ${anime.episodeCount}` : '⏳ Airing';

            // Add time remaining if available and not N/A
            const timeDisplay = anime.timeRemaining && anime.timeRemaining !== 'N/A' && anime.timeRemaining !== 'Unknown' 
                ? ` ⏰ ${anime.timeRemaining}` : '';

            // Truncate long titles
            const title = anime.englishTitle.length > 50 ? 
                anime.englishTitle.substring(0, 47) + '...' : 
                anime.englishTitle;

            response += `**${index + 1}.** ${title}\n`;

            // Add Japanese title if available and different from English
            if (anime.japaneseTitle && anime.japaneseTitle !== 'N/A' && anime.japaneseTitle !== anime.englishTitle) {
                const jpTitle = anime.japaneseTitle.length > 40 ? 
                    anime.japaneseTitle.substring(0, 37) + '...' : 
                    anime.japaneseTitle;
                response += `   🇯🇵 *${jpTitle}*\n`;
            }

            response += `   ${epDisplay}${timeDisplay}\n`;
            response += `   🔗 \`${anime.url}\`\n\n`;
        });

        // Add footer with timestamp
        const timestamp = new Date().toLocaleString('en-US', { 
            hour: 'numeric', 
            minute: 'numeric', 
            hour12: true,
            timeZone: 'UTC'
        });
        response += `🕐 *Last updated: ${timestamp} UTC*`;

        // Check if response is too long
        if (response.length > 2000) {
            // Split into multiple messages
            await loadingMsg.delete();

            // Send first part (header)
            await message.channel.send('📺 **Latest 10 Anime on AnimeHeaven** (Part 1/2)\n');

            // Send first 5 anime
            let part1 = '';
            for (let i = 0; i < 5; i++) {
                const anime = latestAnime[i];
                part1 += formatAnimeEntry(i + 1, anime);
            }
            await message.channel.send(part1);

            // Send remaining 5 anime
            let part2 = '**Continued...**\n\n';
            for (let i = 5; i < 10; i++) {
                const anime = latestAnime[i];
                part2 += formatAnimeEntry(i + 1, anime);
            }
            part2 += `🕐 *Last updated: ${timestamp} UTC*`;
            await message.channel.send(part2);

        } else {
            await loadingMsg.edit(response);
        }

    } catch (error) {
        console.error('Latest command error:', error);
        await loadingMsg.edit(`❌ **Error fetching latest anime:** ${error.message}`);
    }
}

    // !delete command
    if (message.content.startsWith('!delete')) {
        const args = message.content.split(' ').slice(1);

        if (args.length < 1) {
            // List all directories if no name provided
            const dirs = listDirectories();
            if (dirs.length === 0) {
                await message.channel.send('❌ No anime folders found!');
            } else {
                await message.channel.send(`📁 Available folders: \`${dirs.join('`, `')}\`\nUsage: \`!delete <folder_name>\``);
            }
            return;
        }

        const directoryName = args[0];
        const statusMsg = await message.channel.send(`🗑️ Preparing to delete "${directoryName}"...`);

        try {
            const result = deleteDirectory(directoryName);

            if (result.success) {
                await statusMsg.edit(result.message);
            } else {
                await statusMsg.edit(result.message);
            }

        } catch (error) {
            console.error('Error in !delete command:', error);
            await statusMsg.edit(`❌ Error deleting folder: ${error.message}`);
        }
    }

    // !list command
    if (message.content === '!list') {
        const dirs = listDirectories();
        if (dirs.length === 0) {
            await message.channel.send('📭 No anime folders found!');
        } else {
            // Count episodes in each folder
            let response = '📁 **Available Anime Folders:**\n';
            for (const dir of dirs) {
                const folderPath = `./${dir}`;
                if (fs.existsSync(folderPath)) {
                    const files = fs.readdirSync(folderPath)
                        .filter(file => file.endsWith('.mp4'));
                    response += "•" + "`" + dir + "`" + " - " + files.length + " episodes \n"
                }
            }
            await message.channel.send(response);
        }
    }

    if (message.content.startsWith('!search')) {
        const args = message.content.split(' ').slice(1);

        if (args.length === 0) {
            await message.channel.send('❌ Please provide an anime name to search: `!search <anime_name>`');
            return;
        }

        const searchQuery = args.join(' ');
        const searchMsg = await message.channel.send(`🔍 **Searching for "${searchQuery}"...**`);

        try {
            const results = await searchAnimeList(searchQuery);

            if (results.length === 0) {
                await searchMsg.edit(`❌ **No results found for "${searchQuery}"**`);
                return;
            }

            // Create formatted message
            let response = `🔍 **Search Results for "${searchQuery}":**\n\n`;

            results.forEach((anime, index) => {
                // Truncate long titles
                const title = anime.title.length > 60 ? 
                    anime.title.substring(0, 57) + '...' : 
                    anime.title;

                response += `**${index + 1}.** ${title}\n`;
                response += `   📎 \`${anime.url}\`\n\n`;
            });

            // Discord has 2000 character limit
            if (response.length > 1900) {
                response = response.substring(0, 1900) + '\n... (more results available)';
            }

            await searchMsg.edit(response);

        } catch (error) {
            console.error('Search command error:', error);
            await searchMsg.edit(`❌ **Search failed:** ${error.message}`);
        }
    }

    // !help command
    if (message.content.startsWith('!txt ')) {
        const text = message.content.slice(5);
        const tmpFile = path.join(require('os').tmpdir(), `txt_${Date.now()}.txt`);
        try {
            fs.writeFileSync(tmpFile, text, 'utf8');
            await message.channel.send({ files: [{ attachment: tmpFile, name: 'output.txt' }] });
            await message.delete();
        } catch (err) {
            console.error('Error sending txt file:', err);
            await message.channel.send('Failed to create txt file.');
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    }

    if (message.content === "!help") {
        await message.channel.send(`

**Video Downloaders:**
• Post any Instagram link (auto-downloads reels/posts)

**Anime Commands:**
• \`!download <anime_name>\` - Download anime series (creates channel & auto-uploads)
• \`!download <anime_name> <episode>\` - Start from specific episode
• \`!loopdn <anime_name>\` - Download, upload & delete one episode at a time (saves storage)
• \`!loopdn <anime_name> <episode>\` - Loop download starting from specific episode
• \`!info <anime_name>\` - Show anime information in current channel
• \`!search <anime_name>\` - Search for anime
• \`!send <folder_name>\` - Send downloaded episodes to anime channel
• \`!delete <folder_name>\` - Delete anime folder
• \`!list\` - List all downloaded anime
• \`!txt <text>\` - Convert text to a .txt file and send it
        `);
    }
});

client.login(process.env.token);
