# select_room

This example shows one way to allow a user to select a room.

The user may enter a room name into the form element defined in the HTML. When the user submits the form the room name is sent as a query parameter in the URL and the page is reloaded. (The demo is loaded in an iframe so you don't see its URL in the address bar.)

The sketch checks to see if the query parameter is set. If it is, it sets the room to the value of the query parameter when it connects.

If the room is not specified, the sketch doesn't connect and displays a prompt to choose a room.

- **type** a custom room name into the field
- **click** "Join Room"
- **click** to move the dot

> Open this example in two browser windows at once!
