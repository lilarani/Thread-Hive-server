require('dotenv').config();
const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_kEY);
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());
app.use(cors({ origin: ['http://localhost:5173'] }));

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.fdepx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    // database and collections
    const database = client.db('threadHive');
    const postsCollection = database.collection('posts');
    const usersCollection = database.collection('users');
    const successedPaymentCollection = database.collection('successedPayment');
    const announcementCollection = database.collection('announcements');
    const commentsCollection = database.collection('comments');

    // jwt related api
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '4h',
      });
      res.send({ token });
    });

    // middlewares
    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).send({ message: 'unauthorized' });
      }
      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: 'unauthorized access' });
        }
        req.decoded = decoded;
        next();
      });
    };

    // user verify admin after verifyToken
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) {
        return res.status(403).send({ message: 'Forbidden Access' });
      }
      next();
    };

    // payment intent
    app.post('/create-payment-intent', async (req, res) => {
      // const { price } = req.body;
      let price = 200;
      const amount = parseInt(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card'],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // user related api
    app.post('/users', async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: 'user already exists', insertedId: null });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.get('/users/:email', async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });

    app.get('/users/admin/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'Forbidden access' });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      let admin = false;
      if (user) {
        admin = user?.role === 'admin';
      }
      res.send({ admin });
    });

    app.patch(
      '/users/admin/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: 'admin',
          },
        };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      }
    );

    // post related api
    app.get('/posts', async (req, res) => {
      const allPost = req.body;
      const result = await postsCollection.find(allPost).toArray();
      res.send(result);
    });

    app.post('/posts', async (req, res) => {
      const newPost = req.body;
      const { userEmail } = newPost;

      const user = await usersCollection.findOne({ email: userEmail });

      const isMember = user.membership;

      if (!isMember) {
        const postCount = await postsCollection.countDocuments({
          userEmail: userEmail,
        });

        if (postCount >= 5) {
          return res.status(400).json({
            message:
              'You can only create up to 5 posts. Become a member to add more posts.',
          });
        }
      }

      const result = await postsCollection.insertOne(newPost);

      res.status(201).json({
        message: 'Post added successfully!',
        result,
      });
    });

    app.get('/my-post', async (req, res) => {
      const { userEmail } = req.query;

      if (!userEmail) {
        return res.send({
          membership: false,
          postCount: 0,
        });
      }

      const user = await usersCollection.findOne({ email: userEmail });

      if (!user) {
        return res.send({
          membership: false,
          postCount: 0,
        });
      }

      const isMember = user.membership || false;

      const postCount = await postsCollection.countDocuments({
        userEmail: userEmail,
      });

      res.send({
        membership: isMember,
        postCount: postCount,
      });
    });

    app.get('/posts/:email', async (req, res) => {
      const email = req.params.email;
      const posts = { userEmail: email };
      const result = await postsCollection.find(posts).toArray();
      res.send(result);
    });

    app.get('/posts/recent/:email', async (req, res) => {
      const email = req.params.email;
      const posts = { userEmail: email };
      const recentpost = await postsCollection
        .find(posts)
        .sort({ date: -1 })
        .limit(3)
        .toArray();
      res.send(recentpost);
    });

    app.delete('/posts/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await postsCollection.deleteOne(query);
      res.send(result);
    });

    // upVote API to increment upVote count
    app.patch('/posts/downVote/:id', async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedUpVotes = {
        $inc: {
          upVote: 1,
        },
      };
      const result = await postsCollection.updateOne(filter, updatedUpVotes);
      res.send(result);
    });

    // downVote API to decrement upDownVote count
    app.patch('/posts/downVote/:id', async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updatedDownVotes = {
        $inc: {
          downVote: 1,
        },
      };
      const result = await postsCollection.updateOne(filter, updatedDownVotes);
      res.send(result);
    });

    // payment related api
    app.post('/successedPayment', async (req, res) => {
      const payment = req.body;
      const result = await successedPaymentCollection.insertOne(payment);
      res.send(result);
    });

    app.patch('/successedPayment/:email', async (req, res) => {
      const email = req.params.email;
      const filter = { email: email };
      const updatedDoc = {
        $set: {
          badge: 'https://i.ibb.co.com/PmPQ4Qr/gold.jpg',
          membership: true,
          status: 'Active',
        },
      };
      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    // announcement related api
    app.post('/announcements', verifyToken, verifyAdmin, async (req, res) => {
      const announcement = req.body;
      const result = await announcementCollection.insertOne(announcement);
      res.send(result);
    });

    // Comment related api
    app.post('/comments', async (req, res) => {
      const { postId, email, commentText } = req.body;
      const newComment = {
        postId,
        email,
        commentText,
        feedback: '',
        reported: false,
      };

      try {
        const result = await commentsCollection.insertOne(newComment);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to add comment', error });
      }
    });

    app.get('/comments/:postId', async (req, res) => {
      const { postId } = req.params;
      const result = await commentsCollection
        .find({ postId: postId })
        .toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Thread Hive is running');
});

app.listen(port, () => {
  console.log(`Thread Hive listening on port ${port}`);
});
