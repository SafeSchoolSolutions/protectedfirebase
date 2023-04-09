const functions = require("firebase-functions");
const admin = require('firebase-admin');
const { defineString } = require('firebase-functions/params');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { Configuration, OpenAIApi} = require("openai");
const twilio = require("twilio")
const dispatcherNumber = defineString("DISPATCHER_NUMBER")
const twilioNumber = defineString("TWILIO_NUMBER")
const openai_key = defineString("OPENAI_KEY")
const accountSid = defineString("TWILIO_ACCOUNT_SID")
const authToken = defineString("TWILIO_AUTH_TOKEN")
const { Expo } = require('expo-server-sdk');
const { validateRequestWithBody } = require("twilio/lib/webhooks/webhooks");
admin.initializeApp();

exports.newUser = functions.auth.user().onCreate((user) => {
  return admin.firestore()
    .collection("users")
    .doc(user.uid)
    .create(JSON.parse(JSON.stringify(user)));
});

async function getAdminDoc(code) {
  const usersRef = admin.firestore().collection("users")
  const snapshot = await usersRef.where("code", "==", code).where("admin", "==", true).get();
  let data = null;

  if (snapshot.empty) {
    console.log("No matching documents.")
  } else {
    snapshot.forEach(doc => {
      console.log("Found admin document")
      console.log(doc.id, "=>", doc.data())
      data = doc;
    })
  }

  return data;
}


async function getEmergencyDoc(code) {
  const emergenciesRef = admin.firestore().collection("emergencies");
  const snapshot = await emergenciesRef.where('code', '==', code).get();
  let data = null;

  if (snapshot.empty) {
    console.log('No matching documents.');
  } else {
    snapshot.forEach(doc => {
      console.log("Found emergency document");
      console.log(doc.id, '=>', doc.data());
      data = doc;
    });
  }

  return data;
};


async function getResponse(code) {
  const admin_doc_snap = await getAdminDoc(code)
  const school_data = admin_doc_snap.data()

  const doc_snap = await getEmergencyDoc(code)
  const emergency_data = doc_snap.data()

  const configuration = new Configuration({
    apiKey: openai_key.value(),
  })

  const openai = new OpenAIApi(configuration);

  const messages = [
    {"role": "system", "content": `Imagine you are a bystander at a high school that you are very knowledgeable about. Here is some information about the school:
    
    Name: ${school_data.name}
    Location: ${school_data.location}
    Student Count: ${school_data.studentCount}
    Additional Information: ${school_data.additionalInformation}
    
    Imagine you witness a shooting taking place and a 911 operator calls and asks you questions. 
    
    Here is some information about the classroom where it is taking place:
    Name: ${emergency_data.name}
    Location: ${emergency_data.location}
    Student Count: ${emergency_data.studentCount}

    Here is some information about the shooter:
    Age: ${emergency_data.age}
    Sex: ${emergency_data.sex}
    Height: ${emergency_data.height}
    Race: ${emergency_data.race}
    
    Answer the questions as concisely as possible and if you do not know the answer say "I Don't Know".`},
  ];
  
  let i = 1;

  while (i < emergency_data.responses.length) {
    if (i % 2 != 0) {
      var role = "user";
    } else {
      var role = "assistant"
    }

    messages.push({"role": role, "content": emergency_data.responses[i]})
    i++;
  }

  console.log("messages" + messages);
  
  const completion = await openai.createChatCompletion({
    model:"gpt-3.5-turbo",
    messages: messages,
  })

  const response = completion.data.choices[0]['message']['content']
  
  await doc_snap.ref.update({
    responses: [...emergency_data.responses, response]
 })

  return response;
}


exports.call = functions.https.onRequest(async(req, res) => {
  const twiml = new VoiceResponse()

  const gather = twiml.gather({
    numDigits: 3,
    action: '/gather1',
  });

  gather.say('Please select which emergency you are responding too.');

  twiml.redirect('/call');

  res.type('text/xml');
  res.send(twiml.toString());
})

exports.gather1 = functions.https.onRequest(async(req, res) => {
  const twiml = new VoiceResponse()

  if (req.body.Digits) {
    console.log(`/gather2?Digits=${req.body.Digits}`)
    const gather = twiml.gather({
      input: "speech",
      timeout: 5,
      action: `/gather2?Digits=${req.body.Digits}`,
    })

    const admin_doc_snap = await getAdminDoc(req.body.Digits)
    const school_data = admin_doc_snap.data()

    gather.say("Please ask your question regarding the shooting at " + school_data.name)

  } else {
      twiml.redirect('/call');
  }

  // Render the response as XML in reply to the webhook request
  res.type('text/xml');
  res.send(twiml.toString());
})


exports.gather2 = functions.https.onRequest(async(req, res) => {
  const twiml = new VoiceResponse()

  console.log("Question Received", req.body.SpeechResult)

  if (req.body.SpeechResult) {
     const doc_snap = await getEmergencyDoc(req.query.Digits)
     const data = doc_snap.data()

     await doc_snap.ref.update({
       responses: [...data.responses, req.body.SpeechResult]
    })
     const completion = await getResponse(req.query.Digits)
     console.log("GPT-3 Response", completion)
     twiml.say(completion)
  }

  twiml.redirect("/call")

  res.type('text/xml')
  res.send(twiml.toString())

})

async function dispatchFirstResponders(snap) {
  const client = twilio(accountSid.value(), authToken.value());
  const code = snap.data().code;
  console.log("Code", code)
  const admin_doc_snap = await getAdminDoc(code);
  const school_data = admin_doc_snap.data();
  console.log(school_data);

  var textMessage = `This is a ProtectEd alert. A shooting is occuring at: ${school_data.name} located at: ${school_data.location}. Please stay tuned for more information`
  var callMessage = `This is a ProtectEd alert. A shooting is occuring at: ${school_data.name} located at: ${school_data.location}... Organization code: ${school_data.code}. Please call back for additional information.`

  await snap.ref.update({
    responses: [callMessage],
  })

  const usersRef = admin.firestore().collection("users")
  const snapshot = await usersRef.where("code", "==", code).get();

  if (snapshot.empty) {
    console.log("No matching documents.")
  } else {
    snapshot.forEach(async doc => {
      console.log("Found staff document")
      console.log(doc.id, "=>", doc.data())
      var isAdminMember = doc.data().admin;

      const classMember = await doc.ref.collection("students").get();
      classMember.forEach(member => {
        let number = member.data().number;

        if (isAdminMember == true) { 
          console.log(number, "is an admin member. Calling.")
          client.calls
          .create({
             twiml: `<Response><Say>${callMessage}</Say></Response>`,
             to: number,
             from: twilioNumber.value()
           })
          .then(call => console.log(call.sid));
        }
        
        console.log("Texting", number);
        client.messages
        .create({
          body: textMessage, 
          from: twilioNumber.value(), 
          to: number
        })
        .then(message => console.log(message.sid));
      })
    })
  }

  client.calls
      .create({
         twiml: `<Response><Say>${callMessage}</Say></Response>`,
         to: dispatcherNumber.value(),
         from: twilioNumber.value()
       })
      .then(call => console.log(call.sid));
}


exports.alertResponders = functions.firestore
  .document("emergencies/{victimId}")
  .onCreate(async(snap, context) => {
    console.log("Document updated")
    const victim_data = snap.data();
    console.log("REPORTER DATA" + JSON.stringify(victim_data))
    console.log("Dispatching...")
    await dispatchFirstResponders(snap)
  })

