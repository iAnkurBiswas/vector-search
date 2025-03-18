const OpenAI = require('openai');
require('dotenv').config();

// Setup OpenAI configuration
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY});

// Function to get the embeddings using the OpenAI API
async function getEmbedding(text) {
    try {
        const results = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text,
            encoding_format: "float",
        });
        return results.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        throw error;
    }
}

module.exports = { getEmbedding };