// An extension that allows you to import characters from CHub.
// TODO: allow multiple characters to be imported at once
import {
    getRequestHeaders,
    processDroppedFiles,
    callPopup
} from "../../../../script.js";
import { delay, debounce } from "../../../utils.js";
import { extension_settings } from "../../../extensions.js";

const extensionName = "SillyTavern-Chub-Search";
const extensionFolderPath = `scripts/extensions/${extensionName}/`;

// Endpoint for API call
const API_ENDPOINT_SEARCH = "https://gateway.chub.ai/search";
const API_ENDPOINT_DOWNLOAD = "https://api.chub.ai/api/characters/download";
const TRANSLATE_API_ENDPOINT = "http://localhost:7009/translate";
const TRANSLATE_API_KEY = "sk-*";

const defaultSettings = {
    findCount: 10,
    nsfw: false,
    enableTranslation: false,
    translateApiEndpoint: "http://localhost:7009/translate",
    translateApiKey: "sk-*",
};

let chubCharacters = [];
let characterListContainer = null;  // A global variable to hold the reference
let popupState = null;
let savedPopupContent = null;


/**
 * Detects if a string contains Chinese characters
 * @param {string} text - The text to check
 * @returns {boolean} - True if contains Chinese characters
 */
function containsChinese(text) {
    return /[\u4e00-\u9fff]/.test(text);
}

/**
 * Translates Chinese text to English using the translation API
 * @param {string} text - The text to translate
 * @returns {Promise<string>} - The translated text
 */
async function translateToEnglish(text) {
    // Check if translation is enabled
    if (!extension_settings.chub.enableTranslation) {
        return text;
    }

    const apiEndpoint = extension_settings.chub.translateApiEndpoint || TRANSLATE_API_ENDPOINT;
    const apiKey = extension_settings.chub.translateApiKey || TRANSLATE_API_KEY;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                texts: [text],
                target: 'zh-CN'
            })
        });

        if (!response.ok) {
            console.warn('Translation API failed:', response.status, response.statusText);
            return text; // Return original text if translation fails
        }

        const data = await response.json();
        if (data.success && data.translations && data.translations[0]) {
            const translation = data.translations[0];
            return translation.translated_text || text;
        }
        return text;
    } catch (error) {
        console.warn('Translation error:', error);
        return text; // Return original text if translation fails
    }
}

/**
 * Batch translates multiple texts to English using the translation API
 * @param {string[]} texts - Array of texts to translate
 * @returns {Promise<Object>} - Object mapping original text to translated text
 */
async function batchTranslateToEnglish(texts) {
    // Check if translation is enabled
    if (!extension_settings.chub.enableTranslation) {
        const result = {};
        texts.forEach(text => result[text] = text);
        return result;
    }

    const apiEndpoint = extension_settings.chub.translateApiEndpoint || TRANSLATE_API_ENDPOINT;
    const apiKey = extension_settings.chub.translateApiKey || TRANSLATE_API_KEY;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                texts: texts,
                target: 'zh-CN'
            })
        });

        if (!response.ok) {
            console.warn('Batch translation API failed:', response.status, response.statusText);
            // Return original texts if translation fails
            const result = {};
            texts.forEach(text => result[text] = text);
            return result;
        }

        const data = await response.json();
        const result = {};
        
        if (data.success && data.translations && Array.isArray(data.translations)) {
            texts.forEach((text, index) => {
                const translation = data.translations[index];
                if (translation && translation.translated_text) {
                    result[text] = translation.translated_text;
                } else {
                    result[text] = text;
                }
            });
        } else {
            // Fallback: return original texts
            texts.forEach(text => result[text] = text);
        }
        
        return result;
    } catch (error) {
        console.warn('Batch translation error:', error);
        // Return original texts if translation fails
        const result = {};
        texts.forEach(text => result[text] = text);
        return result;
    }
}

/**
 * Asynchronously loads settings from `extension_settings.chub`, 
 * filling in with default settings if some are missing.
 * 
 * After loading the settings, it also updates the UI components 
 * with the appropriate values from the loaded settings.
 */
async function loadSettings() {
    // Ensure extension_settings.timeline exists
    if (!extension_settings.chub) {
        console.log("Creating extension_settings.chub");
        extension_settings.chub = {};
    }

    // Check and merge each default setting if it doesn't exist
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings.chub.hasOwnProperty(key)) {
            console.log(`Setting default for: ${key}`);
            extension_settings.chub[key] = value;
        }
    }
}

/**
 * Saves the current settings to extension_settings.chub using SillyTavern's standard method
 */
function saveSettings() {
    // Use SillyTavern's recommended method for persisting settings
    if (typeof saveSettingsDebounced === 'function') {
        saveSettingsDebounced();
    } else {
        console.warn('saveSettingsDebounced not available, using fallback');
    }
    console.log('Settings saved:', extension_settings.chub);
}

/**
 * Downloads a custom character based on the provided URL.
 * @param {string} input - A string containing the URL of the character to be downloaded.
 * @returns {Promise<void>} - Resolves once the character has been processed or if an error occurs.
 */
async function downloadCharacter(input) {
    const url = input.trim();
    console.debug('Custom content import started', url);
    let request = null;
    // try /api/content/import first and then /import_custom
    request = await fetch('/api/content/import', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url }),
    });
    if (!request.ok) {  
        request = await fetch('/import_custom', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ url }),
        });
    }

    if (!request.ok) {
        toastr.info("Click to go to the character page", 'Custom content import failed', {onclick: () => window.open(`https://www.chub.ai/characters/${url}`, '_blank') });
        console.error('Custom content import failed', request.status, request.statusText);
        return;
    }

    const data = await request.blob();
    const customContentType = request.headers.get('X-Custom-Content-Type');
    const fileName = request.headers.get('Content-Disposition').split('filename=')[1].replace(/"/g, '');
    const file = new File([data], fileName, { type: data.type });

    switch (customContentType) {
        case 'character':
            processDroppedFiles([file]);
            break;
        default:
            toastr.warning('Unknown content type');
            console.error('Unknown content type', customContentType);
            break;
    }
}

/**
 * Updates the character list in the view based on provided characters.
 * @param {Array} characters - A list of character data objects to be rendered in the view.
 */
function updateCharacterListInView(characters) {
    if (characterListContainer) {
        // Get currently selected tags
        const includeTagsInput = document.getElementById('includeTags');
        const selectedTags = includeTagsInput ? includeTagsInput.value.split(',').map(tag => tag.trim()).filter(tag => tag) : [];
        
        characterListContainer.innerHTML = characters.map((character, index) => generateCharacterListItem(character, index, selectedTags)).join('');
    }
}

/**
 * Generates a list of permutations for the given tags. The permutations include:
 * - Original tag.
 * - Tag in uppercase.
 * - Tag with the first letter in uppercase.
 * @param {Array<string>} tags - List of tags for which permutations are to be generated.
 * @returns {Array<string>} - A list containing all the tag permutations.
 */
function makeTagPermutations(tags) {
    let permutations = [];
    for (let tag of tags) {
        if(tag) {
            permutations.push(tag);
            permutations.push(tag.toUpperCase());
            permutations.push(tag[0].toUpperCase() + tag.slice(1));
        }
    }
    return permutations;
}

/**
 * Fetches characters based on specified search criteria.
 * @param {Object} options - The search options object.
 * @param {string} [options.searchTerm] - A search term to filter characters by name/description.
 * @param {Array<string>} [options.includeTags] - A list of tags that the returned characters should include.
 * @param {Array<string>} [options.excludeTags] - A list of tags that the returned characters should not include.
 * @param {boolean} [options.nsfw] - Whether or not to include NSFW characters. Defaults to the extension settings.
 * @param {string} [options.sort] - The criteria by which to sort the characters. Default is by download count.
 * @param {number} [options.page=1] - The page number for pagination. Defaults to 1.
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function fetchCharactersBySearch({ searchTerm, includeTags, excludeTags, nsfw, sort, page=1 }) {

    let first = extension_settings.chub.findCount;
    let asc = false;
    let include_forks = true;
    nsfw = nsfw || extension_settings.chub.nsfw;  // Default to extension settings if not provided
    let require_images = false;
    let require_custom_prompt = false;
    
    // Translate Chinese search terms to English
    let processedSearchTerm = searchTerm;
    if (searchTerm && containsChinese(searchTerm) && extension_settings.chub.enableTranslation) {
        console.log('Detected Chinese in search term, translating...');
        processedSearchTerm = await translateToEnglish(searchTerm);
        console.log(`Translated "${searchTerm}" to "${processedSearchTerm}"`);
    }
    
    searchTerm = processedSearchTerm ? `search=${encodeURIComponent(processedSearchTerm)}&` : '';
    sort = sort || 'default';

    // Construct the URL with the search parameters, if any
    // 
    let url = `${API_ENDPOINT_SEARCH}?excludetopics&first=${first}&page=${page}&namespace=*&${searchTerm}include_forks=${include_forks}&nsfw=${nsfw}&nsfw_only=false&require_custom_prompt=${require_custom_prompt}&require_example_dialogues=false&require_images=${require_images}&require_expressions=false&nsfl=true&asc=${asc}&min_ai_rating=0&min_tokens=50&max_tokens=100000&chub=true&require_lore=false&exclude_mine=true&require_lore_embedded=false&require_lore_linked=false&sort=${sort}&min_tags=2&topics&inclusive_or=false&recommended_verified=false&require_alternate_greetings=false&count=false`;

    //truncate include and exclude tags to 100 characters
    includeTags = includeTags.filter(tag => tag.length > 0);
    if (includeTags && includeTags.length > 0) {
        //includeTags = makeTagPermutations(includeTags);
        includeTags = includeTags.join(',').slice(0, 100);
        url += `&topics=${encodeURIComponent(includeTags)}`;
    }
    //remove tags that contain no characters
    excludeTags = excludeTags.filter(tag => tag.length > 0);
    if (excludeTags && excludeTags.length > 0) {
        //excludeTags = makeTagPermutations(excludeTags);
        excludeTags = excludeTags.join(',').slice(0, 100);
        url += `&excludetopics=${encodeURIComponent(excludeTags)}`;
    }

    let searchResponse = await fetch(url);

    let searchData = await searchResponse.json();

    // Clear previous search results
    chubCharacters = [];

    // Handle new response structure with data.nodes
    const nodes = searchData.data ? searchData.data.nodes : searchData.nodes;
    
    if (!nodes || nodes.length === 0) {
        return chubCharacters;
    }
    let charactersPromises = nodes.map(node => getCharacter(node.fullPath));
    let characterBlobs = await Promise.all(charactersPromises);

    // First, collect all text that needs translation
    const textsToTranslate = new Set();
    const textMapping = new Map(); // Map original text to its usage info
    
    nodes.forEach((node, i) => {
        // Collect names
        if (node.name && !containsChinese(node.name)) {
            textsToTranslate.add(node.name);
            textMapping.set(node.name, { type: 'name', index: i });
        }
        
        // Collect descriptions
        const description = node.tagline || node.description || "Description here...";
        if (description && !containsChinese(description)) {
            textsToTranslate.add(description);
            textMapping.set(description, { type: 'description', index: i });
        }
        
        // Collect tags
        if (node.topics && Array.isArray(node.topics)) {
            node.topics.forEach(tag => {
                if (tag && !containsChinese(tag)) {
                    textsToTranslate.add(tag);
                    if (!textMapping.has(tag)) {
                        textMapping.set(tag, { type: 'tag', indices: [] });
                    }
                    textMapping.get(tag).indices.push(i);
                }
            });
        }
    });

    // Batch translate all collected texts
    let translationResults = {};
    if (textsToTranslate.size > 0 && extension_settings.chub.enableTranslation) {
        console.log(`Translating ${textsToTranslate.size} unique texts...`);
        const textsArray = Array.from(textsToTranslate);
        translationResults = await batchTranslateToEnglish(textsArray);
    }

    // Build final character list with translations
    chubCharacters = nodes.map((node, i) => {
        const originalName = node.name;
        const originalDescription = node.tagline || node.description || "Description here...";
        const originalTags = node.topics || [];

        const character = {
            url: URL.createObjectURL(characterBlobs[i]),
            description: originalDescription,
            name: originalName,
            fullPath: node.fullPath,
            tags: originalTags,
            author: node.fullPath.split('/')[0],
            starCount: node.starCount || 0,
            rating: node.rating || 0,
            ratingCount: node.ratingCount || 0,
            nTokens: node.nTokens || 0,
            forksCount: node.forksCount || 0,
            nChats: node.nChats || 0,
            nMessages: node.nMessages || 0,
            createdAt: node.createdAt,
            lastActivityAt: node.lastActivityAt,
            avatar_url: node.avatar_url,
            max_res_url: node.max_res_url,
            verified: node.verified || false,
            recommended: node.recommended || false,
            nsfw_image: node.nsfw_image || false,
            hasGallery: node.hasGallery || false,
            // Store original texts for hover display
            originalName: originalName,
            originalDescription: originalDescription,
            originalTags: originalTags
        };

        // Apply translations and store translation info
        if (translationResults[character.name]) {
            character.nameTranslated = true;
            character.name = translationResults[character.name];
        }
        if (translationResults[character.description]) {
            character.descriptionTranslated = true;
            character.description = translationResults[character.description];
        }
        if (character.tags && Array.isArray(character.tags)) {
            character.tags = character.tags.map(tag => {
                if (translationResults[tag]) {
                    return {
                        text: translationResults[tag],
                        original: tag,
                        translated: true
                    };
                }
                return {
                    text: tag,
                    original: tag,
                    translated: false
                };
            });
        }

        return character;
    });

    return chubCharacters;
}

/**
 * Searches for characters based on the provided options and manages the UI during the search.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function searchCharacters(options) {
    if (characterListContainer && !document.body.contains(characterListContainer)) {
        console.log('Character list container is not in the DOM, removing reference');
        characterListContainer = null;
    }
    // grey out the character-list-popup while we're searching
    if (characterListContainer) {
        characterListContainer.classList.add('searching');
    }
    console.log('Searching for characters', options);
    const characters = await fetchCharactersBySearch(options);
    if (characterListContainer) {
        characterListContainer.classList.remove('searching');
    }

    return characters;
}

/**
 * Opens the character search popup UI.
 */
function openSearchPopup() {
    displayCharactersInListViewPopup();
}

/**
 * Executes a character search based on provided options and updates the view with the results.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @returns {Promise<void>} - Resolves once the character list has been updated in the view.
 */
async function executeCharacterSearch(options) {
    let characters  = []
    characters = await searchCharacters(options);

    if (characters && characters.length > 0) {
        console.log('Updating character list');
        updateCharacterListInView(characters);
    } else {
        console.log('No characters found');
        characterListContainer.innerHTML = '<div class="no-characters-found">No characters found</div>';
    }
}


/**
 * Generates the HTML structure for a character list item.
 * @param {Object} character - The character data object with properties like url, name, description, tags, and author.
 * @param {number} index - The index of the character in the list.
 * @param {Array<string>} selectedTags - Array of currently selected tags for highlighting.
 * @returns {string} - Returns an HTML string representation of the character list item.
 */
function generateCharacterListItem(character, index, selectedTags = []) {
    const ratingStars = character.rating ? '★'.repeat(Math.floor(character.rating)) + '☆'.repeat(5 - Math.floor(character.rating)) : '';
    const ratingText = character.ratingCount > 0 ? `${ratingStars} (${character.ratingCount})` : 'No rating';
    const tokenText = character.nTokens ? `${character.nTokens} tokens` : '';
    const starText = character.starCount ? `⭐ ${character.starCount}` : '';
    const chatText = character.nChats ? `💬 ${character.nChats}` : '';
    const forkText = character.forksCount ? `🍴 ${character.forksCount}` : '';
    
    // Generate name with hover tooltip for original text
    const nameElement = character.nameTranslated 
        ? `<a href="https://chub.ai/characters/${character.fullPath}" target="_blank" class="name" title="${character.originalName}">${character.name || "Default Name"}</a>`
        : `<a href="https://chub.ai/characters/${character.fullPath}" target="_blank" class="name">${character.name || "Default Name"}</a>`;
    
    // Generate description with hover tooltip for original text
    const descriptionElement = character.descriptionTranslated
        ? `<a href="https://chub.ai/characters/${character.fullPath}" target="_blank" class="description" title="${character.description}">${character.description}</a>`
        : `<a href="https://chub.ai/characters/${character.fullPath}" target="_blank" class="description">${character.description}</a>`;
    
    // Generate tags with hover tooltips for original text
    const tagsElement = character.tags.map(tag => {
        const tagText = typeof tag === 'object' ? tag.text : tag;
        const isSelected = selectedTags.includes(tagText);
        const selectedClass = isSelected ? ' tag-selected' : '';
        
        if (typeof tag === 'object' && tag.translated) {
            return `<span class="tag${selectedClass}" title="${tag.original}">${tag.text}</span>`;
        } else if (typeof tag === 'string') {
            return `<span class="tag${selectedClass}">${tag}</span>`;
        }
        return `<span class="tag${selectedClass}">${tag}</span>`;
    }).join('');
    
    return `
        <div class="character-list-item" data-index="${index}">
            <img class="thumbnail" src="${character.url}">
            <div class="info">
                <div class="character-header">
                    ${nameElement}
                    <a href="https://chub.ai/users/${character.author}" target="_blank" class="author">by ${character.author}</a>
                </div>
                <div class="character-stats">
                    <span class="rating">${ratingText}</span>
                    ${starText ? `<span class="stars">${starText}</span>` : ''}
                    ${tokenText ? `<span class="tokens">${tokenText}</span>` : ''}
                    ${chatText ? `<span class="chats">${chatText}</span>` : ''}
                    ${forkText ? `<span class="forks">${forkText}</span>` : ''}
                </div>
                ${descriptionElement}
                <div class="tags">${tagsElement}</div>
                ${character.verified ? '<span class="verified-badge">✓ Verified</span>' : ''}
                ${character.recommended ? '<span class="recommended-badge">⭐ Recommended</span>' : ''}
            </div>
            <div data-path="${character.fullPath}" class="menu_button download-btn fa-solid fa-cloud-arrow-down faSmallFontSquareFix"></div>
        </div>
    `;
}


/**
 * Displays a popup for character listings based on certain criteria. The popup provides a UI for 
 * character search, and presents the characters in a list view. Users can search characters by 
 * inputting search terms, including/excluding certain tags, sorting by various options, and opting 
 * for NSFW content. The function also offers image enlargement on click and handles character downloads.
 * 
 * If the popup content was previously generated and saved, it reuses that content. Otherwise, it creates 
 * a new layout using the given state or a default layout structure. 
 * 
 * This function manages multiple event listeners for user interactions such as searching, navigating 
 * between pages, and viewing larger character images.
 * 
 * @async
 * @function
 * @returns {Promise<void>} - Resolves when the popup is displayed and fully initialized.
 */
async function displayCharactersInListViewPopup() {
    if (savedPopupContent) {
        console.log('Using saved popup content');
        // Append the saved content to the popup container
        callPopup('', "text", '', { okButton: "Close", wide: true, large: true })
        .then(() => {
            savedPopupContent = document.querySelector('.list-and-search-wrapper');
        });

        document.getElementById('dialogue_popup_text').appendChild(savedPopupContent);
        characterListContainer = document.querySelector('.character-list-popup');
        return;
    }

    const readableOptions = {
        "download_count": "下载次数",
        "id": "ID",
        "rating": "评分",
        "default": "默认",
        "rating_count": "评分数量",
        "last_activity_at": "最后活动",
        "trending_downloads": "热门下载",
        "created_at": "创建日期",
        "name": "名称",
        "n_tokens": "Token数量",
        "random": "随机"
    };

    // TODO: This should be a template
    const listLayout = popupState ? popupState : `
    <div class="list-and-search-wrapper" id="list-and-search-wrapper">
        <div class="character-list-popup">
            ${chubCharacters.map((character, index) => generateCharacterListItem(character, index, [])).join('')}
        </div>
        <hr>
        <div class="search-container">
            <div class="flex-container flex-no-wrap flex-align-center">
            <label for="characterSearchInput"><i class="fas fa-search"></i></label>
            <input type="text" id="characterSearchInput" class="text_pole flex1" placeholder="Search CHUB for characters...">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center">
            <div class="flex-container flex-no-wrap flex-align-center flex1">
            <label for="includeTags"><i class="fas fa-plus-square"></i></label>
            <input type="text" id="includeTags" class="text_pole flex1" placeholder="Include tags (comma separated)">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center flex1">
            <label for="excludeTags"><i class="fas fa-minus-square"></i></label>
            <input type="text" id="excludeTags" class="text_pole flex1" placeholder="Exclude tags (comma separated)">
            </div>
            </div>
            <div class="page-buttons flex-container flex-no-wrap flex-align-center">
                <div class="flex-container flex-no-wrap flex-align-center">
                    <button class="menu_button" id="pageDownButton"><i class="fas fa-chevron-left"></i></button>
                    <label for="pageNumber">Page:</label>
                    <input type="number" id="pageNumber" class="text_pole textarea_compact page-input" min="1" value="1">
                    <button class="menu_button" id="pageUpButton"><i class="fas fa-chevron-right"></i></button>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                <label for="sortOrder">排序方式:</label> <!-- This is the label for sorting -->
                <select class="margin0" id="sortOrder">
                ${Object.keys(readableOptions).map(key => `<option value="${key}">${readableOptions[key]}</option>`).join('')}
                </select>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                    <label for="nsfwCheckbox">NSFW:</label>
                    <input type="checkbox" id="nsfwCheckbox">
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                    <label for="enableTranslationCheckbox">翻译:</label>
                    <input type="checkbox" id="enableTranslationCheckbox">
                    <label for="toggleApiConfig" style="margin-left: 10px; cursor: pointer;">
                        <i class="fas fa-key" id="apiConfigIcon"></i>
                    </label>
                    <input type="radio" id="toggleApiConfig" name="apiConfigToggle" style="display: none;">
                </div>
                <div id="apiConfigContainer" class="api-config-container" style="display: none;">
                    <div class="api-config-tags">
                        <span class="api-config-tag">
                            <label for="translateEndpointInput">翻译API地址:</label>
                            <input type="text" id="translateEndpointInput" class="api-config-input" placeholder="http://localhost:7009/translate">
                        </span>
                        <span class="api-config-tag">
                            <label for="translateKeyInput">翻译API密钥:</label>
                            <input type="text" id="translateKeyInput" class="api-config-input" placeholder="sk-*">
                        </span>
                    </div>
                </div>
                <div class="menu_button" id="characterSearchButton">Search</div>
            </div>


        </div>
    </div>
`;

    // Call the popup with our list layout
    callPopup(listLayout, "text", '', { okButton: "Close", wide: true, large: true })
        .then(() => {
            savedPopupContent = document.querySelector('.list-and-search-wrapper');
        });

    characterListContainer = document.querySelector('.character-list-popup');   

    // Initialize settings UI
    document.getElementById('nsfwCheckbox').checked = extension_settings.chub.nsfw || false;
    document.getElementById('enableTranslationCheckbox').checked = extension_settings.chub.enableTranslation || false;
    document.getElementById('translateEndpointInput').value = extension_settings.chub.translateApiEndpoint || TRANSLATE_API_ENDPOINT;
    document.getElementById('translateKeyInput').value = extension_settings.chub.translateApiKey || TRANSLATE_API_KEY;

    let clone = null;  // Store reference to the cloned image

    characterListContainer.addEventListener('click', function (event) {
        if (event.target.tagName === 'IMG') {
            const image = event.target;

            if (clone) {  // If clone exists, remove it
                document.body.removeChild(clone);
                clone = null;
                return;  // Exit the function
            }

            const rect = image.getBoundingClientRect();

            clone = image.cloneNode(true);
            clone.style.position = 'absolute';
            clone.style.top = `${rect.top + window.scrollY}px`;
            clone.style.left = `${rect.left + window.scrollX}px`;
            clone.style.transform = 'scale(4)';  // Enlarge by 4 times
            clone.style.zIndex = 99999;  // High value to ensure it's above other elements
            clone.style.objectFit = 'contain';

            document.body.appendChild(clone);

            // Prevent this click event from reaching the document's click listener
            event.stopPropagation();
        }
    });

    // Add event listener to remove the clone on next click anywhere
    document.addEventListener('click', function handler() {
        if (clone) {
            document.body.removeChild(clone);
            clone = null;
        }
    });


    characterListContainer.addEventListener('click', async function (event) {
        if (event.target.classList.contains('download-btn')) {
            downloadCharacter(event.target.getAttribute('data-path'));
        } else if (event.target.classList.contains('tag')) {
            // Handle tag click - toggle tag in include tags
            const tagText = event.target.textContent.trim();
            const includeTagsInput = document.getElementById('includeTags');
            const currentValue = includeTagsInput.value.trim();
            
            if (currentValue === '') {
                // If no tags, add this tag
                includeTagsInput.value = tagText;
            } else {
                // Check if tag already exists
                const existingTags = currentValue.split(',').map(tag => tag.trim());
                if (existingTags.includes(tagText)) {
                    // Tag exists, remove it
                    const updatedTags = existingTags.filter(tag => tag !== tagText);
                    includeTagsInput.value = updatedTags.join(', ');
                } else {
                    // Tag doesn't exist, add it
                    includeTagsInput.value = currentValue + ', ' + tagText;
                }
            }
            
            // Trigger search with updated tags
            const searchEvent = new Event('change');
            includeTagsInput.dispatchEvent(searchEvent);
        }
    });

    const executeCharacterSearchDebounced = debounce((options) => executeCharacterSearch(options), 750);

    // Combine the 'keydown' and 'click' event listeners for search functionality, debounce the inputs
    const handleSearch = async function (e) {
        console.log('handleSearch', e);
        if (e.type === 'keydown' && e.key !== 'Enter' && e.target.id !== 'includeTags' && e.target.id !== 'excludeTags') {
            return;
        }

        const splitAndTrim = (str) => {
            str = str.trim(); // Trim the entire string first
            if (!str.includes(',')) {
                return [str];
            }
            return str.split(',').map(tag => tag.trim());
        };

        console.log(document.getElementById('includeTags').value);

        const searchTerm = document.getElementById('characterSearchInput').value;
        const includeTags = splitAndTrim(document.getElementById('includeTags').value);
        const excludeTags = splitAndTrim(document.getElementById('excludeTags').value);
        const nsfw = document.getElementById('nsfwCheckbox').checked;
        const sort = document.getElementById('sortOrder').value;
        let page = document.getElementById('pageNumber').value;

        // If the page number is not being changed, use page 1
        // Check if the target is a button or if its parent is a button (for icon clicks)
        const isPageButton = e.target.id === 'pageUpButton' || e.target.id === 'pageDownButton' || 
                            e.target.closest('#pageUpButton') || e.target.closest('#pageDownButton');
        const isPageNumberInput = e.target.id === 'pageNumber';
        
        if (!isPageButton && !isPageNumberInput) {
            page = 1;
            // set page box to 1
            document.getElementById('pageNumber').value = 1;
        }

        executeCharacterSearchDebounced({
            searchTerm,
            includeTags,
            excludeTags,
            nsfw,
            sort,
            page
        });
    };

    // debounce the inputs
    document.getElementById('characterSearchInput').addEventListener('change', handleSearch);
    document.getElementById('characterSearchButton').addEventListener('click', handleSearch);
    document.getElementById('includeTags').addEventListener('keyup', handleSearch);
    document.getElementById('excludeTags').addEventListener('keyup', handleSearch);
    document.getElementById('sortOrder').addEventListener('change', handleSearch);
    document.getElementById('nsfwCheckbox').addEventListener('change', function(e) {
        extension_settings.chub.nsfw = e.target.checked;
        handleSearch(e);
    });
    document.getElementById('enableTranslationCheckbox').addEventListener('change', function(e) {
        extension_settings.chub.enableTranslation = e.target.checked;
        // Save settings
        saveSettings();
    });
    
    // Toggle API configuration visibility
    document.getElementById('toggleApiConfig').addEventListener('change', function(e) {
        const apiConfigContainer = document.getElementById('apiConfigContainer');
        const apiConfigIcon = document.getElementById('apiConfigIcon');
        
        if (e.target.checked) {
            apiConfigContainer.style.display = 'block';
            apiConfigIcon.style.color = '#007bff'; // Blue color when active
        } else {
            apiConfigContainer.style.display = 'none';
            apiConfigIcon.style.color = ''; // Reset to default color
        }
    });
    document.getElementById('translateEndpointInput').addEventListener('change', function(e) {
        extension_settings.chub.translateApiEndpoint = e.target.value;
        saveSettings();
    });
    document.getElementById('translateKeyInput').addEventListener('change', function(e) {
        extension_settings.chub.translateApiKey = e.target.value;
        saveSettings();
    });

    // when the page number is finished being changed, search again
    document.getElementById('pageNumber').addEventListener('change', handleSearch);
    // on page up or down, update the page number, don't go below 1
    document.getElementById('pageUpButton').addEventListener('click', function (e) {
        let pageNumber = document.getElementById('pageNumber'); 

        pageNumber.value = parseInt(pageNumber.value) + 1;
        pageNumber.value = Math.max(1, pageNumber.value);
        handleSearch(e);
    }
    );
    document.getElementById('pageDownButton').addEventListener('click', function (e) {
        let pageNumber = document.getElementById('pageNumber');
        pageNumber.value = parseInt(pageNumber.value) - 1;
        pageNumber.value = Math.max(1, pageNumber.value);
        handleSearch(e);
    }
    );
}

/**
 * Fetches a character by making an API call.
 * 
 * This function sends a POST request to the API_ENDPOINT_DOWNLOAD with a provided character's fullPath. 
 * It requests the character in the "tavern" format and the "main" version. Once the data is fetched, it 
 * is converted to a blob before being returned.
 * 
 * @async
 * @function
 * @param {string} fullPath - The unique path/reference for the character to be fetched.
 * @returns {Promise<Blob>} - Resolves with a Blob of the fetched character data.
 */
async function getCharacter(fullPath) {
    let response = await fetch(
        API_ENDPOINT_DOWNLOAD,
        {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fullPath: fullPath,
                format: "tavern",
                version: "main"
            }),
        }
    );

    // If the request failed, try a backup endpoint - https://avatars.charhub.io/{fullPath}/avatar.webp
    if (!response.ok) {
        console.log(`Request failed for ${fullPath}, trying backup endpoint`);
        response = await fetch(
            `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp`,
            {
                method: "GET",
                headers: {
                    'Content-Type': 'application/json'
                },
            }
        );
    }
    let data = await response.blob();
    return data;
}

/**
 * jQuery document-ready block:
 * - Fetches the HTML settings for an extension from a known endpoint and prepares a button for character search.
 * - The button, when clicked, triggers the `openSearchPopup` function.
 * - Finally, it loads any previously saved settings related to this extension.
 */
jQuery(async () => {
    // put our button in between external_import_button and rm_button_group_chats in the form_character_search_form
    // on hover, should say "Search CHub for characters"
    $("#external_import_button").after('<button id="search-chub" class="menu_button fa-solid fa-cloud-bolt faSmallFontSquareFix" title="Search CHub for characters"></button>');
    $("#search-chub").on("click", function () {
        openSearchPopup();
    });

    loadSettings();
});
