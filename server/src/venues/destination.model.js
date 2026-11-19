import mongoose from 'mongoose';
import { TRANSIT_MODES, WEATHER_CONDITIONS } from './vocabulary.js';

const point = { lat: { type: Number, required: true }, lng: { type: Number, required: true } };

// One document per destination: identity, transit links between
// neighbourhoods, and mocked weather (monthly normals + a daily forecast).
const destinationSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    country: { type: String, required: true },
    timezone: { type: String, required: true },
    currency: { type: String, required: true },
    center: point,
    image: { type: {
      url: String,
      credit: String,
      license: String,
      source: String,
    }, default: undefined },
    transit: [
      {
        _id: false,
        from: String,
        to: String,
        mode: { type: String, enum: TRANSIT_MODES },
        minutes: Number,
        costPerPerson: Number,
        line: String,
      },
    ],
    weather: {
      monthly: [
        {
          _id: false,
          month: Number,
          condition: { type: String, enum: WEATHER_CONDITIONS },
          highC: Number,
          lowC: Number,
          rainDays: Number,
        },
      ],
      daily: [
        {
          _id: false,
          date: String,
          condition: { type: String, enum: WEATHER_CONDITIONS },
          highC: Number,
          lowC: Number,
          precipitationChance: Number,
        },
      ],
    },
    datasetVersion: { type: String, required: true },
  },
  { timestamps: true },
);

export const Destination = mongoose.model('Destination', destinationSchema);
