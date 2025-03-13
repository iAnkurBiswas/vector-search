var express = require('express');
var router = express.Router();
const { MongoClient, ObjectId } = require("mongodb");
const OpenAI = require('openai');

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

router.get('/createSearchIndex', async (req, res, next) => {
  try {
    // Ensure database connection
    await connectToDatabase();
    
    const database = client.db("test");
    const collection = database.collection("recipes");

    // define your Atlas Vector Search index
    const index = {
      name: "vector_index",
      type: "search",
      definition: {
        mappings: {
          dynamic: true,
          fields: {
            plot_embedding: {
              type: "knnVector",
              dimensions: 1536,
              similarity: "cosine",
            },
            name: {
              type: "string",
              analyzer: "lucene.standard"
            },
            steps: [{
              type: "string",
              analyzer: "lucene.standard"
            }],
            ingredients: [{
              type: "string",
              analyzer: "lucene.standard"
            }],
            category: {
              type: "objectId"
            },
            subcategory: {
              type: "objectId"
            }
          }
        }
      }
    }

    // Create the search index using createIndex command
    try {
      const result = await collection.createIndex(
        { "$**": "text" },
        { name: index.name, ...index.definition }
      );

      console.log(`Search index created with name: ${result}`);
      
      // Check if index exists and is ready
      const indexes = await collection.listIndexes().toArray();
      const searchIndex = indexes.find(idx => idx.name === index.name);
      
      if (searchIndex) {
        res.json({
          success: true,
          message: 'Search index created successfully',
          indexName: result
        });
      } else {
        throw new Error('Index was not created successfully');
      }

    } catch (indexError) {
      if (indexError.code === 85) { // Index already exists
        res.json({
          success: true,
          message: 'Search index already exists',
          indexName: index.name
        });
      } else {
        throw indexError;
      }
    }

  } catch (error) {
    console.error('Error creating search index:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create search index',
      message: error.message
    });
  }
});

router.post('/search', async (req, res, next) => {
  try {
    // if (!process.env.OPENAI_API_KEY) {
    //   throw new Error('OPENAI_API_KEY environment variable is not set');
    // }

    await connectToDatabase();
    
    const database = client.db("test");
    const collection = database.collection("recipes");
    
    const {
      query,           // text query to search for
      category,        // optional category ObjectId
      subcategory,    // optional subcategory ObjectId
      limit = 10      // number of results to return
    } = req.body;

    // Input validation
    if (limit < 1 || limit > 50) {
      return res.status(400).json({
        success: false,
        error: 'Invalid limit value',
        message: 'Limit must be between 1 and 50'
      });
    }

    // Convert string IDs to ObjectId if provided
    let categoryId, subcategoryId;
    try {
      if (category) categoryId = new ObjectId(category);
      if (subcategory) subcategoryId = new ObjectId(subcategory);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ID format',
        message: 'Category or subcategory ID is not valid'
      });
    }

    // Generate embedding for the search query using OpenAI
    let embedding;
    if (query) {
      try {
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-ada-002",
          input: query,
        });
        embedding = embeddingResponse.data[0].embedding;
      } catch (error) {
        console.error('OpenAI API Error:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to generate embedding',
          message: 'Error processing search query'
        });
      }
    }

    // Build the search pipeline
    const searchPipeline = {
      index: "vector_index",
      knnBeta: embedding ? {
        vector: embedding,
        path: "plot_embedding",
        k: limit
      } : undefined,
      compound: {
        should: [
          // Text search across multiple fields if query is provided
          query ? {
            text: {
              query: query,
              path: ["name", { value: "steps", multi: "array" }, { value: "ingredients", multi: "array" }],
              fuzzy: {
                maxEdits: 1,
                prefixLength: 3
              }
            }
          } : undefined,
        ].filter(Boolean),
        filter: [
          // Add category filter if provided
          categoryId ? {
            equals: {
              path: "category",
              value: categoryId
            }
          } : undefined,
          // Add subcategory filter if provided
          subcategoryId ? {
            equals: {
              path: "subcategory",
              value: subcategoryId
            }
          } : undefined
        ].filter(Boolean)
      }
    };

    // Remove knnBeta if no embedding is provided
    if (!embedding) {
      delete searchPipeline.knnBeta;
    }

    // Execute the search
    const searchResults = await collection.aggregate([
      {
        $search: searchPipeline
      },
      {
        $limit: limit
      },
      {
        $project: {
          _id: 1,
          name: 1,
          ingredients: 1,
          steps: 1,
          category: 1,
          subcategory: 1,
          score: { $meta: "searchScore" }
        }
      }
    ]).toArray();

    res.json({
      success: true,
      results: searchResults,
      count: searchResults.length
    });

  } catch (error) {
    console.error('Error performing search:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform search',
      message: error.message
    });
  }
});

module.exports = router;
