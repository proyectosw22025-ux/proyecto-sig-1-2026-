// Ruta RELATIVA al mismo origen: el navegador pide /graphql/ al host que sirve
// la página y Nginx (o el proxy de Vite en dev) lo reenvía al backend. Así no
// hay IP hardcodeada y funciona igual en local y en el VPS.
const GRAPHQL_URL = '/graphql/';

async function queryGraphQL(query: string, variables: Record<string, any> = {}) {
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const json = await response.json();
    if (json.errors) {
      throw new Error(json.errors.map((e: any) => e.message).join(', '));
    }
    return json.data;
  } catch (error) {
    console.error("GraphQL Query Error:", error);
    throw error;
  }
}

export const graphqlService = {
  async getStops() {
    const query = `
      query GetStops {
        stops {
          id
          name
          latitude
          longitude
          routes {
            id
            name
            color
          }
        }
      }
    `;
    const data = await queryGraphQL(query);
    return data.stops;
  },

  async getRoutes() {
    const query = `
      query GetRoutes {
        routes {
          id
          name
          color
          sentido
          geomGeojson
          stopIds
        }
      }
    `;
    const data = await queryGraphQL(query);
    return data.routes;
  },

  async searchStops(queryStr: string) {
    const query = `
      query SearchStops($queryStr: String!) {
        searchStops(query: $queryStr) {
          id
          name
          latitude
          longitude
          routes {
            id
            name
            color
          }
        }
      }
    `;
    const data = await queryGraphQL(query, { queryStr });
    return data.searchStops;
  },

  async searchRoutes(queryStr: string) {
    const query = `
      query SearchRoutes($queryStr: String!) {
        searchRoutes(query: $queryStr) {
          id
          name
          color
          sentido
          geomGeojson
          stopIds
        }
      }
    `;
    const data = await queryGraphQL(query, { queryStr });
    return data.searchRoutes;
  },

  async planTrip(originLat: number, originLng: number, destLat: number, destLng: number) {
    const query = `
      query PlanTrip($oLat: Float!, $oLng: Float!, $dLat: Float!, $dLng: Float!) {
        planTrip(originLat: $oLat, originLng: $oLng, destLat: $dLat, destLng: $dLng) {
          transfers
          walkDistanceM
          walkMinutes
          rideMinutes
          totalMinutes
          exact
          legs {
            rideDistanceM
            rideMinutes
            boardStop { id name latitude longitude }
            alightStop { id name latitude longitude }
            route {
              id
              name
              color
              sentido
              geomGeojson
              stopIds
            }
          }
        }
      }
    `;
    const data = await queryGraphQL(query, { oLat: originLat, oLng: originLng, dLat: destLat, dLng: destLng });
    return data.planTrip;
  },

  async getClosestStop(latitude: number, longitude: number) {
    const query = `
      query GetClosestStop($latitude: Float!, $longitude: Float!) {
        closestStop(latitude: $latitude, longitude: $longitude) {
          id
          name
          latitude
          longitude
          distance
          routes {
            id
            name
            color
          }
        }
      }
    `;
    const data = await queryGraphQL(query, { latitude, longitude });
    return data.closestStop;
  }
};
