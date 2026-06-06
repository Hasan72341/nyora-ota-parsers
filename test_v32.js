import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';

async function test() {
    const key = 'a-villains-will-to-survive-46f09241';
    const apiBase = 'https://api.asurascans.com';
    
    console.log('Testing v32 chapters fetch...');
    try {
        const res = await fetch(apiBase + '/api/series/' + key + '/chapters?nyoraTry=' + Date.now());
        const data = await res.json();
        console.log('Chapters Found:', Array.isArray(data.data) ? data.data.length : 'None');
    } catch (e) {
        console.error('Error:', e.message);
    }
}

test();