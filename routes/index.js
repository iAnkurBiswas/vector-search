var express = require('express');
var router = express.Router();
const { MongoClient } = require("mongodb");
const OpenAI = require('openai');
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

    // Get all recipes
    const recipes = await collection.find({}).toArray();
    console.log(`Found ${recipes.length} recipes to process`);

    let processedCount = 0;
    let errorCount = 0;

    // Process each recipe
    for (const recipe of recipes) {
      try {
        // Format the text for better semantic understanding
        const textToEmbed = [
          `Recipe: ${recipe.name}`,
          `Ingredients: ${Array.isArray(recipe.ingredients) ? recipe.ingredients.join(', ') : recipe.ingredients}`,
          `Steps: ${Array.isArray(recipe.steps) ? recipe.steps.join(' ') : recipe.steps}`
        ].join('\n');

        // Generate embedding using OpenAI
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-ada-002",
          input: textToEmbed,
        });

        const embedding = embeddingResponse.data[0].embedding;

        // Validate embedding format
        if (!Array.isArray(embedding) || embedding.length !== 1536) {
          throw new Error(`Invalid embedding format: ${JSON.stringify(embedding)}`);
        }

        // Update the recipe with the embedding
        await collection.updateOne(
          { _id: recipe._id },
          { $set: { plot_embedding: embedding } }
        );

        processedCount++;
        if (processedCount % 10 === 0) {
          console.log(`Processed ${processedCount} recipes...`);
        }
      } catch (error) {
        console.error(`Error processing recipe ${recipe._id}:`, error);
        errorCount++;
      }
    }

    // Get final count of documents with embeddings
    const finalCount = await collection.countDocuments({ plot_embedding: { $exists: true } });

    res.json({
      success: true,
      message: 'Embeddings created successfully',
      stats: {
        totalRecipes: recipes.length,
        processedCount,
        errorCount,
        finalCount
      }
    });

  } catch (error) {
    console.error('Error creating embeddings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create embeddings',
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

router.post('/reply', async (req, res, next) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const {
      conversationArr,      // array of conversation messages
    } = req.body;

    // Input validation
    if (!Array.isArray(conversationArr) || conversationArr.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid conversation array',
        message: 'conversationArr must be a non-empty array of messages'
      });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: conversationArr,
      temperature: 0.7,
      max_tokens: 1000
    });

    res.json({
      success: true,
      message: response.choices[0].message.content
    });
  } catch (error) {
    console.error('Error in reply route:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process reply',
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