#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_FILE = join(homedir(), '.todos.json');

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

// Check for --file flag
let dataFile = DEFAULT_FILE;
const fileIndex = args.indexOf('--file');
if (fileIndex !== -1 && args[fileIndex + 1]) {
  dataFile = args[fileIndex + 1];
}

// Load todos from file
function loadTodos() {
  if (!existsSync(dataFile)) {
    return [];
  }
  try {
    const data = readFileSync(dataFile, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading todos file:', error.message);
    return [];
  }
}

// Save todos to file
function saveTodos(todos) {
  try {
    writeFileSync(dataFile, JSON.stringify(todos, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving todos file:', error.message);
    process.exit(1);
  }
}

// Commands
function addTodo(text) {
  const todos = loadTodos();
  const newTodo = {
    id: todos.length > 0 ? Math.max(...todos.map(t => t.id)) + 1 : 1,
    text,
    completed: false,
    createdAt: new Date().toISOString()
  };
  todos.push(newTodo);
  saveTodos(todos);
  console.log(`Added: "${text}"`);
}

function listTodos() {
  const todos = loadTodos();
  if (todos.length === 0) {
    console.log('No todos found.');
    return;
  }
  
  console.log('\nYour Todos:');
  console.log('─'.repeat(50));
  todos.forEach((todo, index) => {
    const status = todo.completed ? '✓' : ' ';
    const display = todo.completed ? `\x1b[2m${todo.text}\x1b[0m` : todo.text;
    console.log(`${index + 1}. [${status}] ${display}`);
  });
  console.log('─'.repeat(50));
  console.log(`Total: ${todos.length} (${todos.filter(t => t.completed).length} completed)\n`);
}

function completeTodo(id) {
  const todos = loadTodos();
  const index = parseInt(id) - 1;
  
  if (index < 0 || index >= todos.length) {
    console.error(`Error: Todo #${id} not found.`);
    process.exit(1);
  }
  
  todos[index].completed = true;
  saveTodos(todos);
  console.log(`Completed: "${todos[index].text}"`);
}

function removeTodo(id) {
  const todos = loadTodos();
  const index = parseInt(id) - 1;
  
  if (index < 0 || index >= todos.length) {
    console.error(`Error: Todo #${id} not found.`);
    process.exit(1);
  }
  
  const removed = todos.splice(index, 1)[0];
  saveTodos(todos);
  console.log(`Removed: "${removed.text}"`);
}

function showHelp() {
  console.log(`
Todo CLI - A simple command-line todo list manager

Usage:
  node index.js <command> [arguments] [options]

Commands:
  add <text>       Add a new todo item
  list             List all todo items
  complete <id>    Mark a todo as completed
  remove <id>      Remove a todo item
  help             Show this help message

Options:
  --file <path>    Use a custom file for storing todos (default: ~/.todos.json)

Examples:
  node index.js add "Buy groceries"
  node index.js list
  node index.js complete 1
  node index.js remove 2
  node index.js add "Task" --file ./my-todos.json
`);
}

// Main command router
switch (command) {
  case 'add':
    if (args.length < 2 || args[1].startsWith('--')) {
      console.error('Error: Please provide a todo text.');
      process.exit(1);
    }
    addTodo(args[1]);
    break;
    
  case 'list':
    listTodos();
    break;
    
  case 'complete':
    if (args.length < 2 || args[1].startsWith('--')) {
      console.error('Error: Please provide a todo ID.');
      process.exit(1);
    }
    completeTodo(args[1]);
    break;
    
  case 'remove':
    if (args.length < 2 || args[1].startsWith('--')) {
      console.error('Error: Please provide a todo ID.');
      process.exit(1);
    }
    removeTodo(args[1]);
    break;
    
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
    
  default:
    if (!command) {
      showHelp();
    } else {
      console.error(`Error: Unknown command "${command}"`);
      console.log('Run "node index.js help" for usage information.');
      process.exit(1);
    }
}
