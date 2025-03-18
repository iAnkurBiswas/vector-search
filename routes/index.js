var express = require('express');
var router = express.Router();
const { MongoClient } = require("mongodb");
const OpenAI = require('openai');
const { getEmbedding } = require('../functions/get-embeddings');
require('dotenv').config();

// connect to your Atlas deployment
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize connection once
let dbConnection;
async function connectToDatabase() {
  if (!dbConnection) {
    try {
      if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI environment variable is not set');
      }
      await client.connect();
      dbConnection = true;
      console.log("Connected to MongoDB Atlas");
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
}

/* GET home page. */
router.get('/', function (req, res, next) {
  res.render('index', { title: 'Express' });
});

router.get('/createEmbedding', async (req, res, next) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    // Ensure database connection
    await connectToDatabase();

    const database = client.db(process.env.MONGODB_DB || "test");
    const collection = database.collection("recipes");

    // First, remove any existing embeddings
    await collection.updateMany(
      { plot_embedding: { $exists: true } },
      { $unset: { plot_embedding: "" } }
    );

    // Filter to exclude null or empty name fields
    const filter = { 
      "name": { "$exists": true, "$ne": "" }, 
    };
    
    // Get a subset of documents from the collection
    const documents = await collection.find(filter).toArray();
    console.log(`Found ${documents.length} documents to process`);
    
    if (documents.length === 0) {
      return res.json({
        success: true,
        message: 'No documents found to process'
      });
    }

    const updateDocuments = [];
    let processedCount = 0;
    let errorCount = 0;

    // Process documents in batches of 10 to avoid overwhelming the API
    const batchSize = 50;
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      await Promise.all(batch.map(async doc => {
        try {
          // Format the text for better semantic understanding
          const textToEmbed = [
            `Recipe: ${doc.name}`,
          ].join('\n');

          // Generate an embedding using the function that you defined
          const embedding = await getEmbedding(textToEmbed);
          
          // Verify embedding format
          if (!Array.isArray(embedding) || embedding.length !== 1536) {
            throw new Error(`Invalid embedding format: ${JSON.stringify(embedding)}`);
          }

          // Add the embedding to an array of update operations
          updateDocuments.push({
            updateOne: {
              filter: { "_id": doc._id },
              update: { $set: { "plot_embedding": embedding } }
            }
          });
          processedCount++;
          console.log(`Processed document ${doc._id}: ${doc.name}`);
        } catch (error) {
          console.error(`Error processing document ${doc._id}:`, error);
          errorCount++;
        }
      }));

      console.log(`Processed ${processedCount}/${documents.length} documents`);
    }
    
    if (updateDocuments.length > 0) {
      // Update documents with the new embedding field
      const result = await collection.bulkWrite(updateDocuments, { ordered: false });
      console.log(`Successfully updated ${result.modifiedCount} documents`);
    }

    // Verify some documents were updated
    const updatedDocs = await collection.countDocuments({ plot_embedding: { $exists: true } });
    console.log(`Total documents with embeddings: ${updatedDocs}`);

    res.json({
      success: true,
      message: 'Embeddings creation completed',
      stats: {
        totalDocuments: documents.length,
        processedCount,
        errorCount,
        updatedCount: updateDocuments.length,
        documentsWithEmbeddings: updatedDocs
      }
    });

  } catch (error) {
    console.error('Error creating embedding:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create embedding',
      message: error.message,
      details: error
    });
  }
});

router.get('/createSearchIndex', async (req, res, next) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    // Ensure database connection
    await connectToDatabase();

    const database = client.db(process.env.MONGODB_DB || "test");
    const collection = database.collection("recipes");

    // First, try to drop the existing index if it exists
    try {
      await collection.dropIndex("vector_index");
      console.log("Dropped existing vector_index");
    } catch (dropError) {
      // Ignore error if index doesn't exist
      console.log("No existing index to drop");
    }

    // Create the vector search index
    const result = await collection.createIndex(
      { plot_embedding: 1 },
      {
        name: "vector_index",
        type: "vectorSearch",
        dimensions: 1536,
        similarity: "cosine"
      }
    );

    console.log('Index creation result:', result);

    // Verify the index was created
    const indexes = await collection.listIndexes().toArray();
    const searchIndex = indexes.find(idx => idx.name === "vector_index");
    
    if (searchIndex) {
      res.json({
        success: true,
        message: 'Search index created successfully',
        indexName: "vector_index",
        details: searchIndex
      });
    } else {
      throw new Error('Index was not created successfully');
    }

  } catch (error) {
    console.error('Error creating search index:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create search index',
      message: error.message,
      details: error
    });
  }
});

router.get('/debug', async (req, res, next) => {
  try {
    await connectToDatabase();
    const database = client.db(process.env.MONGODB_DB || "test");
    const collection = database.collection("recipes");

    // Get total documents
    const totalDocs = await collection.countDocuments();
    
    // Get documents with embeddings
    const docsWithEmbeddings = await collection.countDocuments({
      plot_embedding: { $exists: true }
    });

    // Get sample document with embedding
    const sampleDoc = await collection.findOne({
      plot_embedding: { $exists: true }
    });

    // Get indexes
    const indexes = await collection.listIndexes().toArray();

    res.json({
      success: true,
      databaseState: {
        totalDocuments: totalDocs,
        documentsWithEmbeddings: docsWithEmbeddings,
        sampleDocument: sampleDoc ? {
          id: sampleDoc._id,
          name: sampleDoc.name,
          hasEmbedding: !!sampleDoc.plot_embedding,
          embeddingLength: sampleDoc.plot_embedding ? sampleDoc.plot_embedding.length : 0
        } : null,
        indexes: indexes
      }
    });

  } catch (error) {
    console.error('Error checking database state:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check database state',
      message: error.message,
      details: error
    });
  }
});

router.post('/search', async (req, res, next) => {
  try {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    await connectToDatabase();

    const database = client.db(process.env.MONGODB_DB || "test");
    const collection = database.collection("recipes");

    const {
      query,           // text query to search for
      limit = 10      // number of results to return
    } = req.body;

    // Input validation
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid query',
        message: 'Query must be a non-empty string'
      });
    }

    if (limit < 1 || limit > 50) {
      return res.status(400).json({
        success: false,
        error: 'Invalid limit value',
        message: 'Limit must be between 1 and 50'
      });
    }

    // Verify the index exists
    const indexes = await collection.listIndexes().toArray();
    const searchIndex = indexes.find(idx => idx.name === "vector_index");
    
    if (!searchIndex) {
      return res.status(404).json({
        success: false,
        error: 'Search index not found',
        message: 'Please create the search index first using /createSearchIndex'
      });
    }

    // First, try to find the specific recipe
    const specificRecipe = await collection.findOne({
      name: "BBQ Field Peppers & Onions Stuffed with Spanakorizo"
    });
    console.log('Specific recipe found:', specificRecipe ? {
      id: specificRecipe._id,
      name: specificRecipe.name,
      hasEmbedding: !!specificRecipe.plot_embedding,
      embeddingLength: specificRecipe.plot_embedding ? specificRecipe.plot_embedding.length : 0
    } : 'Not found');

    // Generate embedding for the search query using OpenAI
    let embedding;
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: query.trim(),
      });
      embedding = embeddingResponse.data[0].embedding;
    } catch (error) {
      console.error('OpenAI API Error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate embedding',
        message: 'Error processing search query',
        details: error.message
      });
    }

    // Try a text search first to verify we have documents
    const textSearchResults = await collection.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { ingredients: { $regex: query, $options: 'i' } }
      ]
    }).limit(5).toArray();

    console.log('Text search results:', textSearchResults.map(doc => ({
      id: doc._id,
      name: doc.name,
      hasEmbedding: !!doc.plot_embedding
    })));

    // Execute the vector search with more lenient parameters
    const searchResults = await collection.aggregate([
      {
        $vectorSearch: {
          queryVector: embedding,
          path: "plot_embedding",
          numCandidates: 100,
          index: "vector_index",
          limit: limit
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          ingredients: 1,
          steps: 1,
          score: { $meta: "vectorSearchScore" }
        }
      }
    ]).toArray();

    console.log('Vector search results count:', searchResults.length);
    if (searchResults.length > 0) {
      console.log('First vector result:', searchResults[0]);
    }

    if (searchResults.length === 0) {
      return res.json({
        success: true,
        message: 'No results found',
        results: [],
        count: 0,
        debug: {
          query: query.trim(),
          embeddingLength: embedding.length,
          specificRecipe: specificRecipe ? {
            id: specificRecipe._id,
            name: specificRecipe.name,
            hasEmbedding: !!specificRecipe.plot_embedding
          } : null,
          textSearchResults: textSearchResults.map(doc => ({
            id: doc._id,
            name: doc.name,
            hasEmbedding: !!doc.plot_embedding
          }))
        }
      });
    }

    res.json({
      success: true,
      message: 'Search completed successfully',
      results: searchResults,
      count: searchResults.length,
      query: query.trim(),
      limit: limit
    });

  } catch (error) {
    console.error('Error performing search:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform search',
      message: error.message,
      details: error
    });
  }
});

// Add this new route to remove embeddings
router.get('/removeEmbeddings', async (req, res, next) => {
  try {
    await connectToDatabase();
    const database = client.db(process.env.MONGODB_DB || "test");
    const collection = database.collection("recipes");

    // Remove the plot_embedding field from all documents
    const result = await collection.updateMany(
      { plot_embedding: { $exists: true } },
      { $unset: { plot_embedding: "" } }
    );

    res.json({
      success: true,
      message: 'Embeddings removed successfully',
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Error removing embeddings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove embeddings',
      message: error.message,
      details: error
    });
  }
});

module.exports = router