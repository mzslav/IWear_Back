
# This is the backend component of a mobile application IWear. Built with Firebase Cloud Functions.

## Getting Started

1. Clone this repository
2. Install dependencies with `npm install`
3. Create a Firebase project and set up Firestore and Storage
4. Add your Firebase configuration in `serviceAccountKey.json`
5. Set up environment variables for API keys
6. Deploy functions with `firebase deploy --only functions`

## Environment Variables

The following environment variables need to be configured:
- `openRouterApi`: API key for OpenRouter AI services
- `openRouterApi2`: Secondary API key for OpenRouter AI services
- `apiKeyOpenWeather`: API key for OpenWeatherMap

## Technical Stack

- **Firebase Cloud Functions**: Serverless backend infrastructure
- **Firebase Authentication**: User authentication and authorization
- **Firestore**: NoSQL database for user and item data
- **Firebase Storage**: Image storage solution
- **AI Integration**: Image analysis via OpenRouter API
- **Weather API**: Integration with OpenWeatherMap


## Collaboration

This project is part of a full-stack mobile application developed in collaboration with @RomanHuriev (https://github.com/RomanHuriev).

- Frontend repository: IWear (https://github.com/RomanHuriev/IWear)

The frontend is built with React-Native and CI/CD Expo
